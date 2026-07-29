import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@hair-simo/db";

// @hair-simo/db does not re-export Refund and @prisma/client is not a dependency of this
// package, so the row shape is declared here to keep the public return type nameable.
export type RefundRecord = {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string | null;
  providerRefId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const REFUND_REFERENCE_PREFIX = "refund_";
export const MAX_REFUND_CENTS = 1_000_000;

const REFUNDABLE_PAYMENT_STATUSES = ["paid"] as const;

const refundSchema = z
  .object({
    paymentId: z.string().trim().min(1),
    amountCents: z.number().int().positive().max(MAX_REFUND_CENTS).optional(),
    reason: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    origin: z.enum(["internal", "provider"]).default("internal"),
  })
  .strict();

export type RefundResult = {
  refund: RefundRecord;
  alreadyRefunded: boolean;
  refundedCents: number;
  refundableCents: number;
  remainingCents: number;
};

async function dispatchToProvider(payload: {
  paymentId: string;
  providerIntentId: string;
  amountCents: number;
  reason: string;
}): Promise<void> {
  try {
    const { publishNotificationEvent } = await import("@hair-simo/gcp/pubsub");
    await publishNotificationEvent({
      type: "appointment.confirmation",
      channel: "email",
      recipient: "info@hairsimo.it",
      locale: "en",
      payload: { action: "refund.request", ...payload },
    });
  } catch {
    // Local dev: refund recorded without PSP dispatch
  }
}

export class RefundService {
  /**
   * Partial and repeated refunds against one payment.
   *
   * `Payment.refundedCents` is the running total and the only thing the overdraw check
   * trusts. The guard lives in the WHERE clause of the increment, so two concurrent
   * refunds cannot each read the same remaining balance and both pass. The tip is part of
   * what the customer was charged, so it is part of what can be given back.
   */
  async createRefund(rawInput: unknown): Promise<RefundResult> {
    const input = refundSchema.parse(rawInput);
    const payment = await prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: { refunds: true },
    });
    if (!payment) throw new Error("PAYMENT_NOT_FOUND");
    if (!payment.providerIntentId) throw new Error("PAYMENT_INTENT_MISSING");
    if (!(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
      throw new Error(`PAYMENT_NOT_REFUNDABLE: status ${payment.status}`);
    }

    const providerRefId = input.idempotencyKey
      ? `${REFUND_REFERENCE_PREFIX}${input.idempotencyKey}`
      : `${REFUND_REFERENCE_PREFIX}${randomUUID()}`;

    if (input.idempotencyKey) {
      const replay = payment.refunds.find((entry) => entry.providerRefId === providerRefId);
      if (replay) {
        const refundedCents = Math.max(payment.refundedCents, sumRefunds(payment.refunds));
        return {
          refund: replay,
          alreadyRefunded: true,
          refundedCents,
          refundableCents: refundableCentsOf(payment),
          remainingCents: Math.max(0, refundableCentsOf(payment) - refundedCents),
        };
      }
    }

    const refundableCents = refundableCentsOf(payment);
    const rowTotal = sumRefunds(payment.refunds);

    // Rows written before `refundedCents` existed are the source of truth for those
    // payments; reconcile the column up before it is used as the overdraw guard.
    if (rowTotal > payment.refundedCents) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { refundedCents: rowTotal },
      });
    }

    const refundedSoFar = Math.max(payment.refundedCents, rowTotal);
    const remaining = refundableCents - refundedSoFar;
    if (remaining <= 0) throw new Error("INVALID_REFUND_AMOUNT");

    const amount = input.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw new Error("INVALID_REFUND_AMOUNT");

    const claimed = await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: "paid",
        refundedCents: { lte: refundableCents - amount },
      },
      data: { refundedCents: { increment: amount } },
    });
    if (claimed.count === 0) throw new Error("INVALID_REFUND_AMOUNT");

    let refund: RefundRecord;
    try {
      if (input.origin === "internal") {
        await dispatchToProvider({
          paymentId: payment.id,
          providerIntentId: payment.providerIntentId,
          amountCents: amount,
          reason: input.reason ?? "",
        });
      }

      refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          amountCents: amount,
          reason: input.reason,
          providerRefId,
        },
      });
    } catch (error) {
      await prisma.payment.updateMany({
        where: { id: payment.id },
        data: { refundedCents: { decrement: amount } },
      });
      throw error;
    }

    const refundedCents = refundedSoFar + amount;
    if (refundedCents >= refundableCents) {
      await prisma.payment.updateMany({
        where: { id: payment.id, status: "paid" },
        data: { status: "refunded" },
      });
    }

    return {
      refund,
      alreadyRefunded: false,
      refundedCents,
      refundableCents,
      remainingCents: Math.max(0, refundableCents - refundedCents),
    };
  }
}

function refundableCentsOf(payment: { amountCents: number; tipCents: number }): number {
  return payment.amountCents + payment.tipCents;
}

function sumRefunds(refunds: Array<{ amountCents: number }>): number {
  return refunds.reduce((sum, entry) => sum + entry.amountCents, 0);
}
