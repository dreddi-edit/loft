import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    redeem: vi.fn(),
    issue: vi.fn(),
    outstandingLiability: vi.fn(),
  },
  db: {
    appointmentFindUnique: vi.fn(),
    paymentFindUnique: vi.fn(),
    voucherFindMany: vi.fn(),
    customerFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  VOUCHER_MIN_CENTS: 500,
  VOUCHER_MAX_CENTS: 200_000,
  VoucherService: class {
    redeem = core.redeem;
    issue = core.issue;
    outstandingLiability = core.outstandingLiability;
  },
  parseVoucherCode: (raw: string) => String(raw).toUpperCase().replace(/[^0-9A-Z]/g, ""),
  voucherExpiryPolicy: () => ({
    defaultValidityMonths: 60,
    minimumValidityMonths: 36,
    description: "policy",
  }),
  salonRepository: { createAuditLog: vi.fn() },
}));

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },

  runWithTenantAsync: async (_ctx: unknown, fn: () => unknown) => fn(),
  prisma: {
    appointment: { findUnique: db.appointmentFindUnique },
    payment: { findUnique: db.paymentFindUnique },
    voucher: { findMany: db.voucherFindMany },
    customer: { findUnique: db.customerFindUnique },
  },
}));

vi.mock("../../../../lib/auth", () => ({
  requireSession: async (request: NextRequest, allowed: RoleKey[]): Promise<AuthSession> => {
    const role = request.headers.get("x-test-role") as RoleKey | null;
    if (!role) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "usr_1", email: `${role}@hairsimo.it`, role, firstName: "S", lastName: "B",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
  },
}));

import {
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
  type LogRecord,
} from "../../../../lib/admin-api";
import { POST, voucherRedeemSchema } from "./route";

const FULL_CODE = "3479ABCDFGHJ";
const URL = "https://admin.hairsimo.it/api/vouchers/redeem";

let audits: AuditEntry[] = [];
let logs: LogRecord[] = [];

function request(body: unknown, role: RoleKey | null = "owner"): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-for": "203.0.113.7",
    "content-type": "application/json",
  };
  if (role !== null) headers["x-test-role"] = role;
  return new NextRequest(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

const validBody = {
  code: "3479-ABCD-FGHJ",
  amountCents: 2_500,
  appointmentId: "apt_1",
};

const redemption = {
  redemptionId: "red_1",
  voucherId: "vou_1",
  code: FULL_CODE,
  displayCode: "3479-ABCD-FGHJ",
  amountCents: 2_500,
  remainingCents: 1_000,
  currency: "EUR",
  idempotent: false,
};

beforeEach(() => {
  audits = [];
  logs = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink((record) => logs.push(record));
  resetAdminRateLimits();
  core.redeem.mockReset();
  db.appointmentFindUnique.mockReset();
  db.paymentFindUnique.mockReset();
  db.appointmentFindUnique.mockResolvedValue({ id: "apt_1", customerId: "cus_1" });
  core.redeem.mockResolvedValue(redemption);
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("POST /api/vouchers/redeem auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await POST(request(validBody, null));
    expect(response.status).toBe(401);
    expect(core.redeem).not.toHaveBeenCalled();
  });

  it("rejects a stylist: spending a voucher is spending money", async () => {
    const response = await POST(request(validBody, "staff"));
    expect(response.status).toBe(403);
    expect(core.redeem).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("admits a manager", async () => {
    expect((await POST(request(validBody, "manager"))).status).toBe(201);
  });
});

describe("POST /api/vouchers/redeem", () => {
  it("redeems against the appointment and reports the remaining balance", async () => {
    const response = await POST(request(validBody));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(core.redeem).toHaveBeenCalledWith("3479-ABCD-FGHJ", 2_500, {
      appointmentId: "apt_1",
      currency: "EUR",
    });
    expect(body.data).toEqual({
      redemptionId: "red_1",
      voucherId: "vou_1",
      displayCode: "3479-ABCD-FGHJ",
      amountCents: 2_500,
      remainingCents: 1_000,
      currency: "EUR",
      idempotent: false,
    });
    expect(body.data.code).toBeUndefined();
  });

  it("keeps the bearer code out of the audit row the wrapper would otherwise copy", async () => {
    await POST(request(validBody));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "voucher.redeem",
      entityType: "voucher",
      entityId: "vou_1",
      actorEmail: "owner@hairsimo.it",
    });
    expect(audits[0].after).toMatchObject({
      codeSuffix: "FGHJ",
      amountCents: 2_500,
      remainingCents: 1_000,
      appointmentId: "apt_1",
      idempotent: false,
    });
    expect(JSON.stringify(audits[0])).not.toContain(FULL_CODE);
    expect(JSON.stringify(audits[0])).not.toContain("3479-ABCD-FGHJ");
    expect(JSON.stringify(logs)).not.toContain("3479");
  });

  it("refuses an appointment that does not exist", async () => {
    db.appointmentFindUnique.mockResolvedValue(null);
    const response = await POST(request(validBody));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("APPOINTMENT_NOT_FOUND");
    expect(core.redeem).not.toHaveBeenCalled();
  });

  it("refuses a payment that belongs to another appointment", async () => {
    db.paymentFindUnique.mockResolvedValue({ id: "pay_9", appointmentId: "apt_other" });
    const response = await POST(request({ ...validBody, paymentId: "pay_9" }));
    expect(response.status).toBe(409);
    expect(core.redeem).not.toHaveBeenCalled();
  });

  it("passes a matching payment through as the idempotency scope", async () => {
    db.paymentFindUnique.mockResolvedValue({ id: "pay_1", appointmentId: "apt_1" });
    await POST(request({ ...validBody, paymentId: "pay_1" }));
    expect(core.redeem).toHaveBeenCalledWith("3479-ABCD-FGHJ", 2_500, {
      appointmentId: "apt_1",
      paymentId: "pay_1",
      currency: "EUR",
    });
  });

  it("reports an overdraw as a conflict with a message the till can read", async () => {
    core.redeem.mockRejectedValue(new Error("VOUCHER_INSUFFICIENT_BALANCE"));
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain("does not have that much left");
  });

  it("reports a blocked card and an unknown code distinctly for the operator", async () => {
    core.redeem.mockRejectedValue(new Error("VOUCHER_INACTIVE"));
    expect((await POST(request(validBody))).status).toBe(409);

    core.redeem.mockRejectedValue(new Error("VOUCHER_NOT_FOUND"));
    expect((await POST(request(validBody))).status).toBe(404);
  });

  it("never returns a raw failure", async () => {
    core.redeem.mockRejectedValue(new Error("could not serialize access due to read/write"));
    const response = await POST(request(validBody));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("serialize");
  });
});

describe("redeem schema", () => {
  it("requires an appointment so the redemption is idempotent", () => {
    expect(() => voucherRedeemSchema.parse({ code: "x", amountCents: 100 })).toThrow();
  });

  it("rejects zero, negative and unbounded amounts and unknown fields", () => {
    expect(() => voucherRedeemSchema.parse({ ...validBody, amountCents: 0 })).toThrow();
    expect(() => voucherRedeemSchema.parse({ ...validBody, amountCents: -100 })).toThrow();
    expect(() => voucherRedeemSchema.parse({ ...validBody, amountCents: 900_000 })).toThrow();
    expect(() => voucherRedeemSchema.parse({ ...validBody, voucherId: "vou_1" })).toThrow();
    expect(() => voucherRedeemSchema.parse({ ...validBody, code: "x".repeat(200) })).toThrow();
  });

  it("defaults the currency to the salon's", () => {
    expect(voucherRedeemSchema.parse(validBody).currency).toBe("EUR");
  });
});
