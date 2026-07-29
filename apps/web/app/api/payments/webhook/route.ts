import { createHmac, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PaymentService, RefundService } from "@hair-simo/core";
import { apiRoute } from "../../../../lib/api-handler";
import { HttpError, serializeError, type ErrorCode } from "../../../../lib/api-errors";
import { timingSafeCompare } from "../../../../lib/shared-secret";

/**
 * Provider webhook contract. Switching from the in-house dispatcher to a real PSP is
 * configuration, not code:
 *
 *   authorization: Bearer <GCP_PAYMENT_WEBHOOK_SECRET>   transport secret, fail-closed in
 *                                                        production via requireSharedSecret
 *   x-payment-signature: t=<unix seconds>,v1=<hex>       HMAC-SHA256 over `${t}.${rawBody}`
 *                                                        keyed with PAYMENT_WEBHOOK_SIGNING_SECRET
 *   x-payment-timestamp: <unix seconds>                  optional, used when the signature
 *                                                        header carries no `t=` element
 *   x-payment-event-id: <provider event id>              optional, used as the idempotency key
 *
 * Signature verification runs on the RAW body before it is parsed. It is enforced as soon
 * as a signing secret exists; a signature that arrives while no secret is configured is
 * refused rather than ignored, so a half-finished PSP migration cannot silently downgrade
 * to bearer-only auth.
 */
const SIGNATURE_HEADER = "x-payment-signature";
const TIMESTAMP_HEADER = "x-payment-timestamp";
const EVENT_ID_HEADER = "x-payment-event-id";
const SIGNING_SECRET_ENV = "PAYMENT_WEBHOOK_SIGNING_SECRET";
const TOLERANCE_ENV = "PAYMENT_WEBHOOK_TOLERANCE_SECONDS";
const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_TOLERANCE_SECONDS = 3_600;
const WEBHOOK_BODY_LIMIT_BYTES = 16_384;

const paymentService = new PaymentService();
const refundService = new RefundService();

const webhookSchema = z
  .object({
    eventId: z.string().trim().min(1).max(128).optional(),
    paymentId: z.string().trim().min(1).max(64),
    appointmentId: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["succeeded", "failed", "refunded"]),
    amountCents: z.number().int().nonnegative().optional(),
    currency: z.string().trim().length(3).optional(),
    googlePayToken: z.string().trim().min(1).max(8_192).optional(),
    providerReference: z.string().trim().min(1).max(128).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "succeeded") return;
    if (value.amountCents === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["amountCents"],
        message: "amountCents is required so the captured amount can be verified.",
      });
    }
    if (!value.googlePayToken && !value.providerReference) {
      ctx.addIssue({
        code: "custom",
        path: ["providerReference"],
        message: "googlePayToken or providerReference is required.",
      });
    }
  });

type WebhookBody = z.infer<typeof webhookSchema>;

const DOMAIN_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  PAYMENT_AMOUNT_MISMATCH: {
    code: "PAYMENT_FAILED",
    message: "The captured amount does not match the amount that was owed.",
  },
  PAYMENT_CURRENCY_MISMATCH: {
    code: "PAYMENT_FAILED",
    message: "The captured currency does not match the amount that was owed.",
  },
  PAYMENT_APPOINTMENT_MISMATCH: {
    code: "CONFLICT",
    message: "The payment does not belong to that appointment.",
  },
  PAYMENT_NOT_CONFIRMABLE: {
    code: "CONFLICT",
    message: "The payment is not in a confirmable state.",
  },
  PAYMENT_NOT_REFUNDABLE: {
    code: "CONFLICT",
    message: "The payment is not in a refundable state.",
  },
  PAYMENT_AMOUNT_INVALID: {
    code: "CONFLICT",
    message: "The payment has no amount to capture.",
  },
  APPOINTMENT_NOT_CONFIRMABLE: {
    code: "CONFLICT",
    message: "The appointment is not in a confirmable state.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    code: "CONFLICT",
    message: "That event id was already used for a different payment.",
  },
  INVALID_REFUND_AMOUNT: {
    code: "VALIDATION_ERROR",
    message: "The refund amount exceeds what is left on the payment.",
  },
};

function translate(error: unknown): unknown {
  if (error instanceof HttpError || !(error instanceof Error)) return error;
  const mapping = DOMAIN_ERRORS[error.message.split(":", 1)[0].trim()];
  if (!mapping) return error;
  return new HttpError(mapping.code, {
    message: mapping.message,
    cause: error,
    logMessage: error.message,
  });
}

function toleranceSeconds(): number {
  const raw = process.env[TOLERANCE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TOLERANCE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TOLERANCE_SECONDS) {
    return DEFAULT_TOLERANCE_SECONDS;
  }
  return parsed;
}

type ParsedSignature = { timestamp: number; signatures: string[] };

function parseSignatureHeader(raw: string, fallbackTimestamp: string | null): ParsedSignature | null {
  const signatures: string[] = [];
  let timestamp = fallbackTimestamp === null ? Number.NaN : Number(fallbackTimestamp.trim());

  for (const element of raw.split(",")) {
    const part = element.trim();
    if (part === "") continue;
    const separator = part.indexOf("=");
    if (separator < 0) {
      signatures.push(part);
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }

  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp: Math.trunc(timestamp), signatures };
}

function unauthorized(detail: string): HttpError {
  return new HttpError("UNAUTHORIZED", { logMessage: `payment webhook: ${detail}` });
}

function verifyWebhookSignature(headers: Headers, rawBody: string, now = Date.now()): void {
  const secret = process.env[SIGNING_SECRET_ENV]?.trim();
  const presented = headers.get(SIGNATURE_HEADER);

  if (!secret) {
    if (presented) throw unauthorized(`signature presented but ${SIGNING_SECRET_ENV} is unset`);
    return;
  }
  if (!presented) throw unauthorized(`${SIGNATURE_HEADER} is missing`);

  const parsed = parseSignatureHeader(presented, headers.get(TIMESTAMP_HEADER));
  if (!parsed) throw unauthorized("signature header is malformed");

  const ageSeconds = Math.abs(Math.floor(now / 1000) - parsed.timestamp);
  if (ageSeconds > toleranceSeconds()) throw unauthorized(`signature is ${ageSeconds}s outside the replay window`);

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  if (!parsed.signatures.some((candidate) => timingSafeCompare(candidate, expected))) {
    throw unauthorized("signature does not match the raw body");
  }
}

async function readRawBody(request: NextRequest): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > WEBHOOK_BODY_LIMIT_BYTES) {
      throw new HttpError("PAYLOAD_TOO_LARGE", { logMessage: `content-length ${size}` });
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > WEBHOOK_BODY_LIMIT_BYTES) {
    throw new HttpError("PAYLOAD_TOO_LARGE", { logMessage: "webhook body exceeds the limit" });
  }
  return raw;
}

/**
 * Without a provider event id, the logical event still has a natural key: one payment
 * moves to one terminal state once. A replay therefore collides on Payment.idempotencyKey
 * instead of producing a second confirmation.
 */
function idempotencyKeyFor(body: WebhookBody, headers: Headers): string {
  const provided = body.eventId ?? headers.get(EVENT_ID_HEADER)?.trim();
  if (provided) return `evt_${provided}`.slice(0, 128);
  return `evt_${body.paymentId}_${body.status}_${body.amountCents ?? "na"}`.slice(0, 128);
}

const handleWebhook = apiRoute<WebhookBody>(
  {
    route: "/api/payments/webhook",
    methods: ["POST"],
    policy: "payment",
    bodyLimitBytes: WEBHOOK_BODY_LIMIT_BYTES,
    schema: webhookSchema,
    sharedSecret: "paymentWebhook",
  },
  async ({ body, req, log }) => {
    const idempotencyKey = idempotencyKeyFor(body, req.headers);

    try {
      if (body.status === "succeeded") {
        const result = await paymentService.confirmPayment({
          paymentId: body.paymentId,
          appointmentId: body.appointmentId,
          providerToken: body.googlePayToken,
          providerReference: body.providerReference,
          amountCents: body.amountCents,
          currency: body.currency,
          idempotencyKey,
        });
        if (result.alreadyConfirmed) {
          log.info("payment webhook replay ignored", { paymentId: body.paymentId });
        }
        return {
          received: true,
          data: {
            paymentId: result.payment.id,
            status: result.payment.status,
            replay: result.alreadyConfirmed,
          },
        };
      }

      if (body.status === "failed") {
        const result = await paymentService.markFailed(body.paymentId, idempotencyKey);
        return {
          received: true,
          data: {
            paymentId: result.payment.id,
            status: result.payment.status,
            replay: !result.changed,
          },
        };
      }

      const refund = await refundService.createRefund({
        paymentId: body.paymentId,
        amountCents: body.amountCents && body.amountCents > 0 ? body.amountCents : undefined,
        reason: body.reason,
        idempotencyKey,
        origin: "provider",
      });
      return {
        received: true,
        data: {
          paymentId: body.paymentId,
          status: "refunded",
          refundedCents: refund.refundedCents,
          remainingCents: refund.remainingCents,
          replay: refund.alreadyRefunded,
        },
      };
    } catch (error) {
      throw translate(error);
    }
  },
);

export async function POST(request: NextRequest): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await readRawBody(request);
    verifyWebhookSignature(request.headers, rawBody);
  } catch (error) {
    const serialized = serializeError(error, randomUUID());
    return NextResponse.json(serialized.body, { status: serialized.status });
  }

  // The body stream is consumed by the signature check, so the pipeline is handed the
  // exact bytes that were verified rather than a re-serialised copy of them.
  return handleWebhook(
    new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: rawBody,
    }),
  );
}
