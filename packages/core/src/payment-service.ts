import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import type { AppointmentStatus, Payment } from "@hair-simo/db";
import { BookingService } from "./booking-service";
import { buildPricing, type PricingResult } from "./pricing-service";
import { VoucherService } from "./voucher-service";

const bookingService = new BookingService();
const voucherService = new VoucherService();

export const PAYMENT_PROVIDER = "google-pay";
export const PAYMENT_CURRENCY = "EUR";
export const MERCHANT_NAME = "Hair Simo";
export const DEFAULT_MERCHANT_COUNTRY = "IT";
export const MERCHANT_COUNTRY_ENV_VAR = "PAYMENTS_MERCHANT_COUNTRY";
export const MAX_TIP_CENTS = 20_000;

const PROVIDER_REFERENCE_MAX_LENGTH = 128;

const PAYABLE_APPOINTMENT_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  "pending",
  "confirmed",
]);

const CONFIRMABLE_PAYMENT_STATUSES = ["pending", "authorized"] as const;

/**
 * Values that ship in the repository as examples. Google Pay renders a payment sheet for
 * them and every tokenization then fails at the gateway, so in production they are a
 * deployment fault and not a degraded mode.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "bcr2dn4twoz7xxxx",
  "examplegatewaymerchantid",
  "examplemerchantid",
  "example",
  "changeme",
  "todo",
]);

const DEV_FALLBACK = {
  merchantId: "BCR2DN4TWOZ7XXXX",
  gateway: "example",
  gatewayMerchantId: "exampleGatewayMerchantId",
} as const;

const warned = new Set<string>();

export function resetPaymentWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(JSON.stringify({ severity: "WARNING", message, component: "payment" }));
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return true;
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  return normalized.includes("xxxx") || normalized.startsWith("example");
}

export type GooglePayConfig = {
  merchantId: string;
  merchantName: string;
  gateway: string;
  gatewayMerchantId: string;
  countryCode: string;
  configured: boolean;
  missing: string[];
};

export function resolveMerchantCountry(): string {
  const raw = process.env[MERCHANT_COUNTRY_ENV_VAR]?.trim().toUpperCase();
  if (!raw) return DEFAULT_MERCHANT_COUNTRY;
  if (!/^[A-Z]{2}$/.test(raw)) {
    const detail = `${MERCHANT_COUNTRY_ENV_VAR}="${raw}" is not an ISO 3166-1 alpha-2 code`;
    if (isProduction()) throw new Error(`PAYMENT_PROVIDER_NOT_CONFIGURED: ${detail}`);
    warnOnce("merchant-country", `${detail}; using ${DEFAULT_MERCHANT_COUNTRY}`);
    return DEFAULT_MERCHANT_COUNTRY;
  }
  return raw;
}

/**
 * `countryCode` is the MERCHANT country, not the customer's. The salon is in Brixen,
 * Italy, so it is IT; the previous "CH" made Google Pay quote a Swiss merchant against an
 * EUR transaction.
 */
export function resolveGooglePayConfig(): GooglePayConfig {
  const countryCode = resolveMerchantCountry();
  const merchantId = process.env.GCP_GOOGLE_PAY_MERCHANT_ID?.trim() ?? "";
  const gateway = process.env.GCP_PAYMENT_GATEWAY?.trim() ?? "";
  const gatewayMerchantId = process.env.GCP_PAYMENT_GATEWAY_MERCHANT_ID?.trim() ?? "";

  const missing: string[] = [];
  if (isPlaceholder(merchantId)) missing.push("GCP_GOOGLE_PAY_MERCHANT_ID");
  if (isPlaceholder(gateway)) missing.push("GCP_PAYMENT_GATEWAY");
  if (isPlaceholder(gatewayMerchantId)) missing.push("GCP_PAYMENT_GATEWAY_MERCHANT_ID");

  if (missing.length > 0) {
    const detail = `unset or placeholder Google Pay configuration: ${missing.join(", ")}`;
    if (isProduction()) throw new Error(`PAYMENT_PROVIDER_NOT_CONFIGURED: ${detail}`);
    warnOnce("google-pay", `${detail}; serving a non-chargeable development payment sheet`);
  }

  return {
    merchantId: missing.includes("GCP_GOOGLE_PAY_MERCHANT_ID")
      ? DEV_FALLBACK.merchantId
      : merchantId,
    merchantName: MERCHANT_NAME,
    gateway: missing.includes("GCP_PAYMENT_GATEWAY") ? DEV_FALLBACK.gateway : gateway,
    gatewayMerchantId: missing.includes("GCP_PAYMENT_GATEWAY_MERCHANT_ID")
      ? DEV_FALLBACK.gatewayMerchantId
      : gatewayMerchantId,
    countryCode,
    configured: missing.length === 0,
    missing,
  };
}

export type GooglePayRequest = {
  apiVersion: 2;
  apiVersionMinor: 0;
  allowedPaymentMethods: Array<{
    type: "CARD";
    parameters: {
      allowedAuthMethods: string[];
      allowedCardNetworks: string[];
    };
    tokenizationSpecification: {
      type: "PAYMENT_GATEWAY";
      parameters: Record<string, string>;
    };
  }>;
  merchantInfo: {
    merchantId: string;
    merchantName: string;
  };
  transactionInfo: {
    totalPriceStatus: "FINAL";
    totalPrice: string;
    currencyCode: string;
    countryCode: string;
  };
};

export type CheckoutResult = {
  provider: typeof PAYMENT_PROVIDER;
  paymentId: string | null;
  paymentRequired: boolean;
  depositRequired: boolean;
  amountCents: number;
  tipCents: number;
  totalChargeCents: number;
  currency: typeof PAYMENT_CURRENCY;
  mode: "deposit" | "full";
  providerConfigured: boolean;
  pricing: {
    totalCents: number;
    depositCents: number;
    depositPercentage: number;
    depositThresholdCents: number;
  };
  googlePayRequest: GooglePayRequest | null;
};

// Deliberately not `.strict()`: `serviceSlug` and `depositPercentage` are still sent by
// clients and are now decided server-side from the appointment, so they are dropped rather
// than echoed back as a validation error.
const checkoutSchema = z.object({
  appointmentId: z.string().trim().min(1),
  mode: z.enum(["deposit", "full"]).default("deposit"),
  tipCents: z.number().int().min(0).max(MAX_TIP_CENTS).default(0),
  customerEmail: z.string().email().optional(),
  voucherCode: z.string().trim().min(1).max(64).optional(),
});

const confirmSchema = z
  .object({
    paymentId: z.string().trim().min(1),
    providerToken: z.string().trim().min(1).optional(),
    providerReference: z.string().trim().min(1).max(PROVIDER_REFERENCE_MAX_LENGTH).optional(),
    amountCents: z.number().int().nonnegative().optional(),
    currency: z.string().trim().length(3).optional(),
    appointmentId: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).max(PROVIDER_REFERENCE_MAX_LENGTH).optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.providerToken ?? value.providerReference), {
    message: "providerToken or providerReference is required",
    path: ["providerToken"],
  });

export type ConfirmPaymentInput = z.input<typeof confirmSchema>;

export type ConfirmPaymentResult = {
  payment: Payment;
  alreadyConfirmed: boolean;
};

export type MarkFailedResult = {
  payment: Payment;
  changed: boolean;
};

function toMajorUnits(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A Google Pay token is a payment credential. Only a non-reversible reference to it is
 * persisted, so a database dump never carries something replayable at the gateway.
 */
function providerReferenceFor(input: { providerReference?: string; providerToken?: string }) {
  if (input.providerReference) return input.providerReference;
  const digest = createHash("sha256").update(input.providerToken ?? "", "utf8").digest("hex");
  return `tok_${digest.slice(0, 40)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export class PaymentService {
  /**
   * Prices the appointment from its own service row. The request may not carry a price, a
   * service or a deposit percentage: a client that could pick any of those could hold a
   * 200 EUR slot against the deposit of a 10 EUR one.
   */
  async createCheckout(rawInput: unknown): Promise<CheckoutResult> {
    const input = checkoutSchema.parse(rawInput);

    const appointment = await prisma.appointment.findUnique({
      where: { id: input.appointmentId },
      include: { service: true },
    });
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    if (!PAYABLE_APPOINTMENT_STATUSES.has(appointment.status)) {
      throw new Error(`APPOINTMENT_NOT_PAYABLE: status ${appointment.status}`);
    }

    const pricing: PricingResult = buildPricing(
      appointment.service.slug,
      appointment.service.priceCents,
    );

    if (appointment.depositRequired !== pricing.depositRequired) {
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: { depositRequired: pricing.depositRequired },
      });
    }

    const baseAmountCents =
      input.mode === "full" ? pricing.fullPayment.amountCents : pricing.deposit.amountCents;

    const pricingSummary = {
      totalCents: pricing.total.amountCents,
      depositCents: pricing.deposit.amountCents,
      depositPercentage: pricing.depositPercentage,
      depositThresholdCents: pricing.depositThresholdCents,
    };

    if (baseAmountCents <= 0) {
      return {
        provider: PAYMENT_PROVIDER,
        paymentId: null,
        paymentRequired: false,
        depositRequired: pricing.depositRequired,
        amountCents: 0,
        tipCents: 0,
        totalChargeCents: 0,
        currency: PAYMENT_CURRENCY,
        mode: input.mode,
        providerConfigured: false,
        pricing: pricingSummary,
        googlePayRequest: null,
      };
    }

    let chargeBaseCents = baseAmountCents;
    let chargeTipCents = input.tipCents;

    if (input.voucherCode) {
      const balance = await voucherService.balance(input.voucherCode);
      const redeemAmount = Math.min(balance.remainingCents, chargeBaseCents + chargeTipCents);
      if (redeemAmount > 0) {
        await voucherService.redeem(input.voucherCode, redeemAmount, {
          appointmentId: appointment.id,
          currency: PAYMENT_CURRENCY,
        });
        let remaining = redeemAmount;
        const fromBase = Math.min(remaining, chargeBaseCents);
        chargeBaseCents -= fromBase;
        remaining -= fromBase;
        chargeTipCents = Math.max(0, chargeTipCents - remaining);
      }
    }

    const totalChargeCents = chargeBaseCents + chargeTipCents;

    if (totalChargeCents <= 0) {
      if (appointment.status !== "confirmed") {
        await bookingService.confirm(appointment.id, "voucher payment");
      }
      return {
        provider: PAYMENT_PROVIDER,
        paymentId: null,
        paymentRequired: false,
        depositRequired: pricing.depositRequired,
        amountCents: 0,
        tipCents: 0,
        totalChargeCents: 0,
        currency: PAYMENT_CURRENCY,
        mode: input.mode,
        providerConfigured: false,
        pricing: pricingSummary,
        googlePayRequest: null,
      };
    }

    const config = resolveGooglePayConfig();

    const pending = await prisma.payment.findFirst({
      where: { appointmentId: appointment.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });

    const payment = pending
      ? await prisma.payment.update({
          where: { id: pending.id },
          data: {
            provider: PAYMENT_PROVIDER,
            amountCents: chargeBaseCents,
            tipCents: chargeTipCents,
            currency: PAYMENT_CURRENCY,
            mode: input.mode,
          },
        })
      : await prisma.payment.create({
          data: {
            appointmentId: appointment.id,
            provider: PAYMENT_PROVIDER,
            providerIntentId: `gpay_${randomUUID()}`,
            amountCents: chargeBaseCents,
            tipCents: chargeTipCents,
            currency: PAYMENT_CURRENCY,
            mode: input.mode,
            status: "pending",
          },
        });

    return {
      provider: PAYMENT_PROVIDER,
      paymentId: payment.id,
      paymentRequired: true,
      depositRequired: pricing.depositRequired,
      amountCents: chargeBaseCents,
      tipCents: chargeTipCents,
      totalChargeCents,
      currency: PAYMENT_CURRENCY,
      mode: input.mode,
      providerConfigured: config.configured,
      pricing: pricingSummary,
      googlePayRequest: {
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: [
          {
            type: "CARD",
            parameters: {
              allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"],
              allowedCardNetworks: ["MASTERCARD", "VISA"],
            },
            tokenizationSpecification: {
              type: "PAYMENT_GATEWAY",
              parameters: {
                gateway: config.gateway,
                gatewayMerchantId: config.gatewayMerchantId,
              },
            },
          },
        ],
        merchantInfo: {
          merchantId: config.merchantId,
          merchantName: config.merchantName,
        },
        transactionInfo: {
          totalPriceStatus: "FINAL",
          totalPrice: toMajorUnits(totalChargeCents),
          currencyCode: PAYMENT_CURRENCY,
          countryCode: config.countryCode,
        },
      },
    };
  }

  /**
   * Marks a payment paid and confirms its appointment. Every check here guards money:
   * the payment must belong to the claimed appointment, the captured amount must equal
   * what was owed, the appointment must still be confirmable, and the transition itself is
   * a compare-and-set so a replayed webhook cannot produce a second confirmation.
   */
  async confirmPayment(rawInput: unknown): Promise<ConfirmPaymentResult> {
    const input = confirmSchema.parse(rawInput);

    if (input.idempotencyKey) {
      const seen = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (seen) {
        if (seen.id !== input.paymentId) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return { payment: seen, alreadyConfirmed: true };
      }
    }

    const payment = await prisma.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");

    if (input.appointmentId && payment.appointmentId !== input.appointmentId) {
      throw new Error("PAYMENT_APPOINTMENT_MISMATCH");
    }
    if (payment.status === "paid") return { payment, alreadyConfirmed: true };
    if (!(CONFIRMABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
      throw new Error(`PAYMENT_NOT_CONFIRMABLE: status ${payment.status}`);
    }

    const expectedAmountCents = payment.amountCents + payment.tipCents;
    if (expectedAmountCents <= 0) throw new Error("PAYMENT_AMOUNT_INVALID");
    if (input.amountCents !== undefined && input.amountCents !== expectedAmountCents) {
      throw new Error("PAYMENT_AMOUNT_MISMATCH");
    }
    if (input.currency && input.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw new Error("PAYMENT_CURRENCY_MISMATCH");
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: payment.appointmentId },
    });
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    if (!PAYABLE_APPOINTMENT_STATUSES.has(appointment.status)) {
      throw new Error(`APPOINTMENT_NOT_CONFIRMABLE: status ${appointment.status}`);
    }

    let claimed: { count: number };
    try {
      claimed = await prisma.payment.updateMany({
        where: { id: payment.id, status: { in: [...CONFIRMABLE_PAYMENT_STATUSES] } },
        data: {
          status: "paid",
          providerIntentId: providerReferenceFor(input),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      claimed = { count: 0 };
    }

    if (claimed.count === 0) {
      const current = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      return { payment: current, alreadyConfirmed: true };
    }

    if (appointment.status !== "confirmed") {
      await bookingService.confirm(payment.appointmentId, input.reason ?? "payment confirmed");
    }

    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { payment: confirmed, alreadyConfirmed: false };
  }

  /**
   * Records a terminal failure reported by the provider. Idempotent: a payment that is
   * already paid is never downgraded, and a replayed failure is a no-op.
   */
  async markFailed(paymentId: string, idempotencyKey?: string): Promise<MarkFailedResult> {
    let updated: { count: number };
    try {
      updated = await prisma.payment.updateMany({
        where: { id: paymentId, status: { in: [...CONFIRMABLE_PAYMENT_STATUSES] } },
        data: { status: "failed", ...(idempotencyKey ? { idempotencyKey } : {}) },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      updated = { count: 0 };
    }
    if (updated.count === 0) {
      const current = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (!current) throw new Error("PAYMENT_NOT_FOUND");
      return { payment: current, changed: false };
    }
    const failed = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return { payment: failed, changed: true };
  }
}
