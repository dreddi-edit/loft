import { z } from "zod";
import { prisma } from "@hair-simo/db";
import type { Money } from "./index";
import { BookingService } from "./booking-service";

const bookingService = new BookingService();

const checkoutSchema = z
  .object({
    appointmentId: z.string().min(1),
    serviceSlug: z.string().min(1),
    mode: z.enum(["deposit", "full"]).default("deposit"),
    depositPercentage: z.number().min(0).max(100).default(30),
    customerEmail: z.string().email().optional(),
  })
  .strict();

export type GooglePayCheckoutResult = {
  provider: "google-pay";
  paymentId: string;
  amountCents: number;
  currency: "EUR";
  mode: "deposit" | "full";
  googlePayRequest: {
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
};

export class PaymentService {
  async createCheckout(
    rawInput: unknown,
    pricing: { deposit: Money; fullPayment: Money },
  ): Promise<GooglePayCheckoutResult> {
    const input = checkoutSchema.parse(rawInput);
    const amount =
      input.mode === "full" ? pricing.fullPayment.amountCents : pricing.deposit.amountCents;
    const merchantId = process.env.GCP_GOOGLE_PAY_MERCHANT_ID ?? "BCR2DN4TWOZ7XXXX";
    const gatewayMerchantId =
      process.env.GCP_PAYMENT_GATEWAY_MERCHANT_ID ?? "exampleGatewayMerchantId";

    const payment = await prisma.payment.create({
      data: {
        appointmentId: input.appointmentId,
        provider: "google-pay",
        providerIntentId: `gpay_${Date.now()}`,
        amountCents: amount,
        mode: input.mode,
        status: "pending",
      },
    });

    return {
      provider: "google-pay",
      paymentId: payment.id,
      amountCents: amount,
      currency: "EUR",
      mode: input.mode,
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
                gateway: process.env.GCP_PAYMENT_GATEWAY ?? "example",
                gatewayMerchantId,
              },
            },
          },
        ],
        merchantInfo: {
          merchantId,
          merchantName: "Hair Simo",
        },
        transactionInfo: {
          totalPriceStatus: "FINAL",
          totalPrice: (amount / 100).toFixed(2),
          currencyCode: "EUR",
          countryCode: "CH",
        },
      },
    };
  }

  async confirmPayment(paymentId: string, googlePayToken: string) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");

    // PSP processes the Google Pay token; this endpoint records confirmation.
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: "paid",
        providerIntentId: googlePayToken.slice(0, 64),
      },
    });

    if (payment.appointmentId) {
      await bookingService.confirm(payment.appointmentId, "payment confirmed");
    }

    return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  }
}
