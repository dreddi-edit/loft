import { VoucherService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";
import { statusOf, withVoucherErrors } from "../route";

const voucherService = new VoucherService();

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const voucherPatchSchema = z
  .object({
    action: z.literal("deactivate"),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type IdParams = { id: string };

/**
 * The routes address a voucher by its database id, not by its code. A code is a bearer
 * credential and a path segment ends up in browser history, referrer headers and every
 * proxy access log on the way, so it is only ever accepted in a query filter the operator
 * types deliberately (GET /api/vouchers?code=...) or in a POST body (redeem).
 */
async function loadVoucher(rawId: string): Promise<{ id: string; code: string }> {
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) {
    throw httpError("VALIDATION_ERROR", {
      message: "The voucher id is not valid.",
      logMessage: "malformed voucher id in path",
    });
  }
  const voucher = await prisma.voucher.findUnique({
    where: { id: parsed.data },
    select: { id: true, code: true },
  });
  if (!voucher) {
    throw httpError("NOT_FOUND", { logMessage: `voucher ${parsed.data} not found` });
  }
  return voucher;
}

export const GET = adminRoute<unknown, undefined, IdParams>(
  { roles: ["owner", "manager"], route: "/api/vouchers/[id]" },
  async ({ params }) => {
    const { code } = await loadVoucher(params.id);
    const detail = await withVoucherErrors(() => voucherService.getVoucher(code));
    // One deliberate lookup at a time is where the full code is allowed to surface: the
    // operator needs it to reissue a lost card. Not cacheable for the same reason.
    return NextResponse.json({ data: detail }, { headers: { "cache-control": "no-store" } });
  },
);

export const PATCH = adminRoute<z.infer<typeof voucherPatchSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager"],
    route: "/api/vouchers/[id]",
    policy: "adminSensitive",
    schema: voucherPatchSchema,
    audit: { entityType: "voucher", action: "voucher.deactivate", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    const { id, code } = await loadVoucher(params.id);

    const before = await prisma.voucher.findUnique({
      where: { id },
      select: { active: true, remainingCents: true, expiresAt: true },
    });
    if (!before) throw httpError("NOT_FOUND", { logMessage: `voucher ${id} disappeared` });

    const voucher = await withVoucherErrors(() => voucherService.deactivate(code, body.reason));

    audit.setEntityId(id);
    audit.setBefore({
      active: before.active,
      status: statusOf(before, new Date()),
      remainingCents: before.remainingCents,
    });
    // Explicit, because the wrapper would otherwise audit the request body, and because the
    // balance left on a blocked card is the number the salon has to answer for later.
    audit.setAfter({
      action: body.action,
      active: voucher.active,
      status: voucher.status,
      remainingCents: voucher.remainingCents,
      currency: voucher.currency,
      reason: body.reason ?? null,
    });

    return {
      data: {
        id: voucher.id,
        codeSuffix: voucher.code.slice(-4),
        active: voucher.active,
        status: voucher.status,
        remainingCents: voucher.remainingCents,
        currency: voucher.currency,
        expiresAt: voucher.expiresAt,
        note: voucher.note,
      },
    };
  },
);
