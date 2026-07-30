import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    getVoucher: vi.fn(),
    deactivate: vi.fn(),
    issue: vi.fn(),
    outstandingLiability: vi.fn(),
  },
  db: {
    voucherFindUnique: vi.fn(),
    voucherFindMany: vi.fn(),
    customerFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  VOUCHER_MIN_CENTS: 500,
  VOUCHER_MAX_CENTS: 200_000,
  VoucherService: class {
    getVoucher = core.getVoucher;
    deactivate = core.deactivate;
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
    voucher: { findUnique: db.voucherFindUnique, findMany: db.voucherFindMany },
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
import { GET, PATCH, voucherPatchSchema } from "./route";

const FULL_CODE = "3479ABCDFGHJ";
const URL = "https://admin.hairsimo.it/api/vouchers/vou_1";

let audits: AuditEntry[] = [];
let logs: LogRecord[] = [];

function request(
  url: string,
  init: { method?: string; role?: RoleKey | null; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
  const role = init.role === undefined ? "owner" : init.role;
  if (role !== null) headers["x-test-role"] = role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  audits = [];
  logs = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink((record) => logs.push(record));
  resetAdminRateLimits();
  core.getVoucher.mockReset();
  core.deactivate.mockReset();
  db.voucherFindUnique.mockReset();
  db.voucherFindUnique.mockResolvedValue({
    id: "vou_1",
    code: FULL_CODE,
    active: true,
    remainingCents: 3_500,
    expiresAt: null,
  });
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/vouchers/[id] auth boundary", () => {
  it("rejects an unauthenticated caller before touching the database", async () => {
    const response = await GET(request(URL, { role: null }), context("vou_1"));
    expect(response.status).toBe(401);
    expect(db.voucherFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a stylist", async () => {
    const response = await GET(request(URL, { role: "staff" }), context("vou_1"));
    expect(response.status).toBe(403);
    expect(core.getVoucher).not.toHaveBeenCalled();
  });
});

describe("GET /api/vouchers/[id] detail", () => {
  it("resolves the id to a code and returns the redemption history uncached", async () => {
    core.getVoucher.mockResolvedValue({
      id: "vou_1",
      code: FULL_CODE,
      displayCode: "3479-ABCD-FGHJ",
      remainingCents: 3_500,
      status: "active",
      redeemedCents: 6_500,
      redemptions: [{ id: "red_1", amountCents: 6_500, appointmentId: "apt_1", paymentId: null }],
    });

    const response = await GET(request(URL), context("vou_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(core.getVoucher).toHaveBeenCalledWith(FULL_CODE);
    expect(body.data.redemptions).toHaveLength(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(logs)).not.toContain(FULL_CODE);
  });

  it("404s an unknown voucher", async () => {
    db.voucherFindUnique.mockResolvedValue(null);
    const response = await GET(request(URL), context("vou_missing"));
    expect(response.status).toBe(404);
    expect(core.getVoucher).not.toHaveBeenCalled();
  });

  it("rejects a path segment that cannot be an id", async () => {
    const response = await GET(request(URL), context("../../etc/passwd"));
    expect(response.status).toBe(400);
    expect(db.voucherFindUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/vouchers/[id] deactivate", () => {
  const deactivated = {
    id: "vou_1",
    code: FULL_CODE,
    displayCode: "3479-ABCD-FGHJ",
    active: false,
    status: "inactive",
    remainingCents: 3_500,
    currency: "EUR",
    expiresAt: null,
    note: "2026-07-29 deactivated: card reported stolen",
  };

  it("blocks the card, audits before and after, and never audits the code", async () => {
    core.deactivate.mockResolvedValue(deactivated);

    const response = await PATCH(
      request(URL, {
        method: "PATCH",
        role: "manager",
        body: { action: "deactivate", reason: "card reported stolen" },
      }),
      context("vou_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(core.deactivate).toHaveBeenCalledWith(FULL_CODE, "card reported stolen");
    expect(body.data).toMatchObject({ id: "vou_1", codeSuffix: "FGHJ", active: false });
    expect(body.data.code).toBeUndefined();

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "voucher.deactivate",
      entityType: "voucher",
      entityId: "vou_1",
      actorEmail: "manager@hairsimo.it",
    });
    expect(audits[0].before).toMatchObject({ active: true, status: "active" });
    expect(audits[0].after).toMatchObject({ active: false, remainingCents: 3_500 });
    expect(JSON.stringify(audits[0])).not.toContain(FULL_CODE);
  });

  it("refuses a stylist and writes no audit row", async () => {
    const response = await PATCH(
      request(URL, { method: "PATCH", role: "staff", body: { action: "deactivate" } }),
      context("vou_1"),
    );
    expect(response.status).toBe(403);
    expect(core.deactivate).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("does not accept any action other than deactivate", async () => {
    const response = await PATCH(
      request(URL, { method: "PATCH", body: { action: "reactivate" } }),
      context("vou_1"),
    );
    expect(response.status).toBe(400);
    expect(core.deactivate).not.toHaveBeenCalled();
  });

  it("maps a service level miss onto 404 rather than 500", async () => {
    core.deactivate.mockRejectedValue(new Error("VOUCHER_NOT_FOUND"));
    const response = await PATCH(
      request(URL, { method: "PATCH", body: { action: "deactivate" } }),
      context("vou_1"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).message).toBe("No voucher matches this code.");
  });

  it("bounds the reason", () => {
    expect(() =>
      voucherPatchSchema.parse({ action: "deactivate", reason: "x".repeat(500) }),
    ).toThrow();
    expect(() => voucherPatchSchema.parse({ action: "deactivate", active: false })).toThrow();
  });
});
