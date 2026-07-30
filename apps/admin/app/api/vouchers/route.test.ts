import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    issue: vi.fn(),
    outstandingLiability: vi.fn(),
  },
  db: {
    voucherFindMany: vi.fn(),
    customerFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  VOUCHER_MIN_CENTS: 500,
  VOUCHER_MAX_CENTS: 200_000,
  VoucherService: class {
    issue = core.issue;
    outstandingLiability = core.outstandingLiability;
  },
  parseVoucherCode: (raw: string) => {
    const stripped = String(raw).toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!/^[3479ABCDFGHJKMPRSTVWXYZ]{12}$/.test(stripped)) {
      throw new Error("VOUCHER_CODE_MALFORMED");
    }
    return stripped;
  },
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
    voucher: { findMany: db.voucherFindMany },
    customer: { findUnique: db.customerFindUnique },
  },
}));

vi.mock("../../../lib/auth", () => ({
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
} from "../../../lib/admin-api";
import { GET, POST, statusOf, translateVoucherError, voucherIssueSchema } from "./route";

const FULL_CODE = "3479ABCDFGHJ";
let audits: AuditEntry[] = [];
let logs: LogRecord[] = [];

function voucherRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "vou_1",
    code: FULL_CODE,
    initialCents: 10_000,
    remainingCents: 3_500,
    currency: "EUR",
    expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    active: true,
    issuedToCustomerId: "cus_1",
    note: "gift for Anna",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

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

beforeEach(() => {
  audits = [];
  logs = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink((record) => logs.push(record));
  resetAdminRateLimits();
  core.issue.mockReset();
  core.outstandingLiability.mockReset();
  db.voucherFindMany.mockReset();
  db.customerFindUnique.mockReset();
  db.voucherFindMany.mockResolvedValue([voucherRow()]);
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/vouchers auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await GET(request("https://admin.hairsimo.it/api/vouchers", { role: null }));
    expect(response.status).toBe(401);
    expect(db.voucherFindMany).not.toHaveBeenCalled();
  });

  it("rejects a stylist: vouchers are money", async () => {
    const response = await GET(request("https://admin.hairsimo.it/api/vouchers", { role: "staff" }));
    expect(response.status).toBe(403);
    expect(db.voucherFindMany).not.toHaveBeenCalled();
  });

  it("admits a manager", async () => {
    const response = await GET(
      request("https://admin.hairsimo.it/api/vouchers", { role: "manager" }),
    );
    expect(response.status).toBe(200);
  });
});

describe("GET /api/vouchers list", () => {
  it("returns the last four characters and never a spendable code", async () => {
    const response = await GET(request("https://admin.hairsimo.it/api/vouchers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: "vou_1", codeSuffix: "FGHJ", status: "active" });
    expect(body.data[0].code).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(FULL_CODE);
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 1, hasMore: false });
  });

  it("canonicalises a code filter into an exact match", async () => {
    await GET(request("https://admin.hairsimo.it/api/vouchers?code=3479-abcd-fghj"));
    expect(db.voucherFindMany.mock.calls[0][0].where).toMatchObject({ code: FULL_CODE });
  });

  it("rejects a mistyped code filter instead of scanning the table", async () => {
    const response = await GET(request("https://admin.hairsimo.it/api/vouchers?code=nope"));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("shape of a voucher code");
    expect(db.voucherFindMany).not.toHaveBeenCalled();
  });

  it("translates a status filter into the same rule the service uses", async () => {
    await GET(request("https://admin.hairsimo.it/api/vouchers?status=expired"));
    const where = db.voucherFindMany.mock.calls[0][0].where;
    expect(where.active).toBe(true);
    expect(where.expiresAt).toHaveProperty("lte");
  });

  it("bounds the page size and rejects unknown query parameters", async () => {
    expect((await GET(request("https://admin.hairsimo.it/api/vouchers?limit=5000"))).status).toBe(
      400,
    );
    expect((await GET(request("https://admin.hairsimo.it/api/vouchers?secret=1"))).status).toBe(400);
  });

  it("serves the outstanding liability report without listing cards", async () => {
    core.outstandingLiability.mockResolvedValue({
      asOf: new Date("2026-07-29T00:00:00.000Z"),
      rows: [{ currency: "EUR", outstandingCents: 12_500 }],
      outstandingCents: 12_500,
    });

    const response = await GET(request("https://admin.hairsimo.it/api/vouchers?view=liability"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.outstandingCents).toBe(12_500);
    expect(db.voucherFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/vouchers issue", () => {
  const summary = {
    id: "vou_9",
    code: FULL_CODE,
    displayCode: "3479-ABCD-FGHJ",
    initialCents: 5_000,
    remainingCents: 5_000,
    currency: "EUR",
    status: "active",
    active: true,
    expiresAt: new Date("2031-07-29T21:59:59.999Z"),
    issuedToCustomerId: null,
    note: null,
    createdAt: new Date("2026-07-29T10:00:00.000Z"),
  };

  it("lets a manager issue and hands back the code exactly once, uncacheable", async () => {
    core.issue.mockResolvedValue(summary);
    const response = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        role: "manager",
        body: { initialCents: 5_000 },
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).data.code).toBe(FULL_CODE);
  });

  it("refuses a stylist", async () => {
    const response = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        role: "staff",
        body: { initialCents: 5_000 },
      }),
    );
    expect(response.status).toBe(403);
    expect(core.issue).not.toHaveBeenCalled();
  });

  it("keeps the issued code out of the audit trail", async () => {
    core.issue.mockResolvedValue(summary);
    await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        body: { initialCents: 5_000 },
      }),
    );

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "voucher.issue",
      entityType: "voucher",
      entityId: "vou_9",
      actorEmail: "owner@hairsimo.it",
      actorRole: "owner",
    });
    expect(JSON.stringify(audits[0])).not.toContain(FULL_CODE);
    expect(JSON.stringify(audits[0])).toContain("FGHJ");
    expect(JSON.stringify(logs)).not.toContain(FULL_CODE);
  });

  it("lets only the owner override the legal minimum validity", async () => {
    core.issue.mockResolvedValue(summary);

    const manager = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        role: "manager",
        body: { initialCents: 5_000, validityMonths: 6, overrideMinimumValidity: true },
      }),
    );
    expect(manager.status).toBe(403);
    expect(core.issue).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);

    const owner = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        role: "owner",
        body: { initialCents: 5_000, validityMonths: 6, overrideMinimumValidity: true },
      }),
    );
    expect(owner.status).toBe(201);
  });

  it("turns a refused validity into a 400 rather than a 500", async () => {
    core.issue.mockRejectedValue(new Error("VOUCHER_VALIDITY_TOO_SHORT"));
    const response = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        body: { initialCents: 5_000, validityMonths: 6 },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("minimum");
  });

  it("does not leak a raw failure to the operator", async () => {
    core.issue.mockRejectedValue(new Error("Invalid `prisma.voucher.create()` invocation"));
    const response = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        body: { initialCents: 5_000 },
      }),
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("prisma");
  });

  it("rejects an unknown recipient before allocating a code", async () => {
    db.customerFindUnique.mockResolvedValue(null);
    const response = await POST(
      request("https://admin.hairsimo.it/api/vouchers", {
        method: "POST",
        body: { initialCents: 5_000, issuedToCustomerId: "cus_missing" },
      }),
    );

    expect(response.status).toBe(404);
    expect(core.issue).not.toHaveBeenCalled();
  });
});

describe("voucher issue schema", () => {
  it("rejects mass assignment and out-of-range amounts", () => {
    expect(() => voucherIssueSchema.parse({ initialCents: 5_000, remainingCents: 1 })).toThrow();
    expect(() => voucherIssueSchema.parse({ initialCents: 100 })).toThrow();
    expect(() => voucherIssueSchema.parse({ initialCents: 500_000 })).toThrow();
    expect(() =>
      voucherIssueSchema.parse({
        initialCents: 5_000,
        validityMonths: 12,
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("defaults currency and the override flag", () => {
    expect(voucherIssueSchema.parse({ initialCents: 5_000 })).toEqual({
      initialCents: 5_000,
      currency: "EUR",
      overrideMinimumValidity: false,
    });
  });
});

describe("voucher status and error translation", () => {
  it("mirrors the service precedence: blocked, then expired, then spent", () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const past = new Date("2026-01-01T00:00:00.000Z");
    expect(statusOf({ active: false, remainingCents: 100, expiresAt: null }, now)).toBe("inactive");
    expect(statusOf({ active: true, remainingCents: 100, expiresAt: past }, now)).toBe("expired");
    expect(statusOf({ active: true, remainingCents: 0, expiresAt: null }, now)).toBe("spent");
    expect(statusOf({ active: true, remainingCents: 1, expiresAt: null }, now)).toBe("active");
  });

  it("passes unknown failures through untranslated so they stay INTERNAL", () => {
    const unknown = new Error("connection refused");
    expect(translateVoucherError(unknown)).toBe(unknown);
  });
});
