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
});

const DOMAIN_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  APPOINTMENT_NOT_PAYABLE: {
    code: "CONFLICT",
    message: "This appointment can no longer be paid for.",
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
