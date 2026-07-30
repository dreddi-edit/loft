import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: { createSeries: vi.fn() },
  db: { recurringFindMany: vi.fn() },
}));

vi.mock("@hair-simo/core", () => ({
  RecurringService: class {
    createSeries = core.createSeries;
  },
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
  prisma: { recurringSeries: { findMany: db.recurringFindMany } },
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
} from "../../../lib/admin-api";
import { GET, POST } from "./route";

const URL = "https://admin.hairsimo.it/api/recurring";

const SERIES = {
  id: "rs_1",
  customerId: "cus_1",
  serviceId: "svc_cut",
  staffId: "stf_1",
  active: true,
  nextAt: new Date("2026-08-05T08:00:00.000Z"),
  intervalWeeks: 2,
  customer: { id: "cus_1", firstName: "Maria", lastName: "Rossi", email: "maria@example.com" },
  service: { id: "svc_cut", slug: "cut", translations: [{ locale: "it", name: "Taglio" }] },
  staff: { id: "stf_1", displayName: "Simona" },
};

let audits: AuditEntry[] = [];

function request(
  init: { method?: string; role?: RoleKey | null; query?: string; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
  const role = init.role === undefined ? "manager" : init.role;
  if (role !== null) headers["x-test-role"] = role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${URL}${init.query ?? ""}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(() => {
  audits = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  db.recurringFindMany.mockReset().mockResolvedValue([SERIES]);
  core.createSeries.mockReset().mockResolvedValue({
    id: "rs_new",
    customerId: "cus_1",
    serviceId: "svc_cut",
    nextAt: new Date("2026-08-05T08:00:00.000Z"),
  });
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/recurring auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    expect((await GET(request({ role: null }))).status).toBe(401);
    expect(db.recurringFindMany).not.toHaveBeenCalled();
  });

  it("admits a stylist", async () => {
    expect((await GET(request({ role: "staff" }))).status).toBe(200);
  });
});

describe("GET /api/recurring", () => {
  it("lists active series ordered by next occurrence", async () => {
    const body = await (await GET(request())).json();

    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 1, hasMore: false });
    expect(db.recurringFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: [{ nextAt: "asc" }, { id: "asc" }],
        skip: 0,
        take: 50,
      }),
    );
  });

  it("filters by active flag and customer", async () => {
    await GET(request({ query: "?active=false&customerId=cus_1&limit=10" }));

    expect(db.recurringFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: false, customerId: "cus_1" },
        take: 10,
      }),
    );
  });
});

describe("POST /api/recurring auth boundary", () => {
  const body = {
    customerId: "cus_1",
    serviceId: "svc_cut",
    staffId: "stf_1",
    firstAt: "2026-08-05T08:00:00.000Z",
    intervalWeeks: 2,
    locale: "it",
    channel: "web",
  };

  it("rejects a stylist", async () => {
    const response = await POST(request({ method: "POST", role: "staff", body }));
    expect(response.status).toBe(403);
    expect(core.createSeries).not.toHaveBeenCalled();
  });

  it("creates a series for a manager and audits it", async () => {
    const response = await POST(request({ method: "POST", role: "manager", body }));

    expect(response.status).toBe(201);
    expect(core.createSeries).toHaveBeenCalledWith(body);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "recurring.create",
      entityType: "recurringSeries",
      entityId: "rs_new",
    });
  });
});
