import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "@hair-simo/db";

const refundSchema = z.object({
  paymentId: z.string().min(1),
  amountCents: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export class RefundService {
  private stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

  async createRefund(rawInput: unknown) {
    const input = refundSchema.parse(rawInput);
    const payment = await prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: { refunds: true },
    });
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");
    if (!payment.providerIntentId) throw new Error("PAYMENT_INTENT_MISSING");

    const refundedSoFar = payment.refunds.reduce((sum, item) => sum + item.amountCents, 0);
    const remaining = payment.amountCents - refundedSoFar;
    const amount = input.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw new Error("INVALID_REFUND_AMOUNT");

    const stripeRefund = await this.stripe.refunds.create({
      payment_intent: payment.providerIntentId,
      amount,
      reason: "requested_by_customer",
      metadata: { paymentId: payment.id, reason: input.reason ?? "" },
    });

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amountCents: amount,
        reason: input.reason,
        providerRefId: stripeRefund.id,
      },
    });

    if (amount >= remaining) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "refunded" },
      });
    }

    return refund;
  }
}
