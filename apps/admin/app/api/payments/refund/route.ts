import { RefundService } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute } from "../../../../lib/admin-api";

const refundService = new RefundService();

/** The refund service owns the field-level schema; the wrapper only asserts an object. */
const refundBodySchema = z.record(z.string(), z.unknown());

export const POST = adminRoute(
  {
    roles: ["owner", "manager"],
    route: "/api/payments/refund",
    schema: refundBodySchema,
    policy: "adminSensitive",
    successStatus: 201,
    audit: { entityType: "payment", action: "payment.refund" },
  },
  async ({ body, audit }) => {
    const result = await refundService.createRefund(body);
    audit.setEntityId(result.refund.paymentId);
    audit.setAfter({
      refundId: result.refund.id,
      paymentId: result.refund.paymentId,
      amountCents: result.refund.amountCents,
      reason: result.refund.reason,
      alreadyRefunded: result.alreadyRefunded,
      refundedCents: result.refundedCents,
      remainingCents: result.remainingCents,
    });
    return { data: result };
  },
);
