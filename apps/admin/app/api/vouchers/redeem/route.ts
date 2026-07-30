import { VOUCHER_MAX_CENTS, VoucherService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";
import { withVoucherErrors } from "../route";

const voucherService = new VoucherService();

const MAX_CODE_INPUT_LENGTH = 64;

export const voucherRedeemSchema = z
  .object({
    code: z.string().trim().min(1).max(MAX_CODE_INPUT_LENGTH),
    amountCents: z.number().int().min(1).max(VOUCHER_MAX_CENTS),
    appointmentId: z.string().trim().min(1).max(64),
    paymentId: z.string().trim().min(1).max(64).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .default("EUR"),
  })
  .strict();

/**
 * Spending a voucher moves money the salon already took, so this is owner/manager only and
 * runs on the `adminSensitive` limiter. The appointment is required rather than optional:
 * it is what makes the redemption idempotent inside VoucherService, so a double-submitted
 * till returns the first redemption instead of spending the card twice.
 */
export const POST = adminRoute<z.infer<typeof voucherRedeemSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/vouchers/redeem",
    policy: "adminSensitive",
    schema: voucherRedeemSchema,
    successStatus: 201,
    audit: { entityType: "voucher", action: "voucher.redeem" },
  },
  async ({ body, audit }) => {
    const appointment = await prisma.appointment.findUnique({
      where: { id: body.appointmentId },
      select: { id: true, customerId: true },
    });
    if (!appointment) {
      throw httpError("APPOINTMENT_NOT_FOUND", {
        logMessage: `redemption references unknown appointment ${body.appointmentId}`,
      });
    }

    if (body.paymentId) {
      const payment = await prisma.payment.findUnique({
        where: { id: body.paymentId },
        select: { id: true, appointmentId: true },
      });
      if (!payment) {
        throw httpError("PAYMENT_NOT_FOUND", {
          logMessage: `redemption references unknown payment ${body.paymentId}`,
        });
      }
      // Otherwise the idempotency scope (which prefers paymentId) could be pointed at a
      // payment belonging to a different appointment entirely.
      if (payment.appointmentId !== appointment.id) {
        throw httpError("CONFLICT", {
          message: "That payment belongs to a different appointment.",
          logMessage: `payment ${payment.id} is not on appointment ${appointment.id}`,
        });
      }
    }

    const result = await withVoucherErrors(() =>
      voucherService.redeem(body.code, body.amountCents, {
        appointmentId: body.appointmentId,
        ...(body.paymentId ? { paymentId: body.paymentId } : {}),
        currency: body.currency,
      }),
    );

    audit.setEntityId(result.voucherId);
    // The wrapper's default `after` is the request body, and the request body contains the
    // code. An AuditLog row is a permanent, widely readable copy of a spendable credential,
    // so the audit gets the suffix and the money, never the code.
    audit.setAfter({
      voucherId: result.voucherId,
      codeSuffix: result.code.slice(-4),
      redemptionId: result.redemptionId,
      amountCents: result.amountCents,
      remainingCents: result.remainingCents,
      currency: result.currency,
      appointmentId: body.appointmentId,
      paymentId: body.paymentId ?? null,
      idempotent: result.idempotent,
    });

    return {
      data: {
        redemptionId: result.redemptionId,
        voucherId: result.voucherId,
        displayCode: result.displayCode,
        amountCents: result.amountCents,
        remainingCents: result.remainingCents,
        currency: result.currency,
        idempotent: result.idempotent,
      },
    };
  },
);
