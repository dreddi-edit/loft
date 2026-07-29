import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PaymentService } from "@hair-simo/core";
import { apiRoute } from "../../../../lib/api-handler";
import { HttpError, safeMessageForCode, type ErrorCode } from "../../../../lib/api-errors";
import { isPaymentsMockAllowed } from "../../../../lib/public-config";

const paymentService = new PaymentService();

const MOCK_BODY_LIMIT_BYTES = 2_048;

const schema = z.object({
  paymentId: z.string().trim().min(1).max(64),
});

const DOMAIN_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  PAYMENT_NOT_CONFIRMABLE: {
    code: "CONFLICT",
    message: "The payment is not in a confirmable state.",
  },
  PAYMENT_AMOUNT_INVALID: {
    code: "CONFLICT",
    message: "The payment has no amount to capture.",
  },
  APPOINTMENT_NOT_CONFIRMABLE: {
    code: "CONFLICT",
    message: "The appointment is not in a confirmable state.",
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

const handleMockConfirm = apiRoute<z.infer<typeof schema>>(
  {
    route: "/api/payments/confirm-mock",
    methods: ["POST"],
    policy: "payment",
    bodyLimitBytes: MOCK_BODY_LIMIT_BYTES,
    schema,
  },
  async ({ body }) => {
    const result = await paymentService
      .confirmPayment({
        paymentId: body.paymentId,
        providerReference: `mock_${randomUUID()}`,
        reason: "mock payment confirmed",
      })
      .catch((error: unknown) => {
        throw translate(error);
      });

    return {
      data: {
        paymentId: result.payment.id,
        status: result.payment.status,
        replay: result.alreadyConfirmed,
        provider: "mock",
      },
    };
  },
);

/**
 * Outside development this endpoint does not exist. It confirms real appointments without
 * money moving, so a 403 would still advertise it; production answers 404 exactly like any
 * unrouted path.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isPaymentsMockAllowed()) {
    return NextResponse.json(
      {
        error: "NOT_FOUND" satisfies ErrorCode,
        message: safeMessageForCode("NOT_FOUND"),
        requestId: randomUUID(),
      },
      { status: 404 },
    );
  }
  return handleMockConfirm(request);
}
