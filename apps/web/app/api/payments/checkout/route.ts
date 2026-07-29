import { z } from "zod";
import { PaymentService } from "@hair-simo/core";
import { apiRoute } from "../../../../lib/api-handler";
import { HttpError, type ErrorCode } from "../../../../lib/api-errors";

const paymentService = new PaymentService();

const CHECKOUT_BODY_LIMIT_BYTES = 4_096;

/**
 * `serviceSlug` and `depositPercentage` are still accepted from older clients and dropped:
 * the amount comes from the appointment's own service row and the server-side deposit
 * policy. A client that could name the service could settle a 200 EUR appointment with the
 * deposit of a 10 EUR one.
 */
const checkoutSchema = z.object({
  appointmentId: z.string().trim().min(1).max(64),
  mode: z.enum(["deposit", "full"]).default("deposit"),
  tipCents: z.number().int().min(0).optional(),
  customerEmail: z.string().trim().email().max(254).optional(),
  voucherCode: z.string().trim().min(1).max(64).optional(),
});

const DOMAIN_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  APPOINTMENT_NOT_PAYABLE: {
    code: "CONFLICT",
    message: "This appointment can no longer be paid for.",
  },
  VOUCHER_CODE_MALFORMED: {
    code: "VALIDATION_ERROR",
    message: "That is not the shape of a voucher code.",
  },
  VOUCHER_CODE_CHECKSUM_FAILED: {
    code: "VALIDATION_ERROR",
    message: "That voucher code has a typo in it. Read it off the card again.",
  },
  VOUCHER_NOT_FOUND: { code: "NOT_FOUND", message: "No voucher matches this code." },
  VOUCHER_INACTIVE: { code: "CONFLICT", message: "This voucher has been blocked." },
  VOUCHER_EXPIRED: { code: "CONFLICT", message: "This voucher has expired." },
  VOUCHER_CURRENCY_MISMATCH: {
    code: "CONFLICT",
    message: "This voucher was issued in a different currency.",
  },
  VOUCHER_INSUFFICIENT_BALANCE: {
    code: "CONFLICT",
    message: "The voucher does not have that much left on it.",
  },
  VOUCHER_REDEMPTION_AMOUNT_MISMATCH: {
    code: "CONFLICT",
    message: "This voucher was already redeemed against this appointment for another amount.",
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

export const POST = apiRoute<z.infer<typeof checkoutSchema>>(
  {
    route: "/api/payments/checkout",
    methods: ["POST"],
    policy: "payment",
    bodyLimitBytes: CHECKOUT_BODY_LIMIT_BYTES,
    schema: checkoutSchema,
  },
  async ({ body, log }) => {
    const checkout = await paymentService.createCheckout(body).catch((error: unknown) => {
      throw translate(error);
    });

    if (checkout.paymentRequired && !checkout.providerConfigured) {
      log.warn("google pay is not fully configured", { appointmentId: body.appointmentId });
    }

    return {
      data: {
        provider: checkout.provider,
        paymentId: checkout.paymentId,
        paymentRequired: checkout.paymentRequired,
        depositRequired: checkout.depositRequired,
        amountCents: checkout.amountCents,
        tipCents: checkout.tipCents,
        totalChargeCents: checkout.totalChargeCents,
        currency: checkout.currency,
        mode: checkout.mode,
        pricing: checkout.pricing,
        googlePayRequest: checkout.googlePayRequest,
      },
    };
  },
);
