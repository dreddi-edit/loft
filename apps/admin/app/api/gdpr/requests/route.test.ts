import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    listDataRequests: vi.fn(),
    createDataRequest: vi.fn(),
  },
  db: {
    customerFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  gdprService: {
    listDataRequests: core.listDataRequests,
    createDataRequest: core.createDataRequest,
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
  prisma: { customer: { findUnique: db.customerFindUnique } },
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
} from "../../../../lib/admin-api";
import { GET, POST, dataRequestCreateSchema, gdprReferenceSchema, reasonPhrase } from "./route";

const URL = "https://admin.hairsimo.it/api/gdpr/requests";

let audits: AuditEntry[] = [];

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "dr_1",
    customerId: "cus_1",
    type: "erasure",
    status: "pending",
    requestedBy: "owner@hairsimo.it",
    completedAt: null,
    resultLocation: null,
    error: null,
    createdAt: new Date("2026-07-29T08:00:00.000Z"),
    updatedAt: new Date("2026-07-29T08:00:00.000Z"),
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
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  core.listDataRequests.mockReset();
  core.createDataRequest.mockReset();
  db.customerFindUnique.mockReset();
  core.listDataRequests.mockResolvedValue([row()]);
  db.customerFindUnique.mockResolvedValue({ id: "cus_1" });
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/gdpr/requests auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    expect((await GET(request(URL, { role: null }))).status).toBe(401);
    expect(core.listDataRequests).not.toHaveBeenCalled();
  });

  it("rejects a stylist: the queue names customers who asked to be erased", async () => {
    expect((await GET(request(URL, { role: "staff" }))).status).toBe(403);
    expect(core.listDataRequests).not.toHaveBeenCalled();
  });

  it("admits a manager", async () => {
    expect((await GET(request(URL, { role: "manager" }))).status).toBe(200);
  });
});

describe("GET /api/gdpr/requests queue", () => {
  it("summarises rows and keeps the stored receipt out of the list", async () => {
    core.listDataRequests.mockResolvedValue([
      row({ status: "completed", resultLocation: JSON.stringify({ removed: { notes: 3 } }) }),
    ]);

    const body = await (await GET(request(URL))).json();

    expect(body.data[0]).toMatchObject({ id: "dr_1", type: "erasure", hasResult: true });
    expect(body.data[0].resultLocation).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("removed");
    expect(body.pagination).toEqual({ limit: 50, count: 1, hasMore: false });
  });

  it("passes the filters straight to the service", async () => {
    await GET(request(`${URL}?customerId=cus_1&status=pending&limit=10`));
    expect(core.listDataRequests).toHaveBeenCalledWith({
      customerId: "cus_1",
      status: "pending",
      take: 10,
    });
  });

  it("bounds the page and rejects unknown filters", async () => {
    expect((await GET(request(`${URL}?limit=5000`))).status).toBe(400);
    expect((await GET(request(`${URL}?status=whatever`))).status).toBe(400);
    expect((await GET(request(`${URL}?customerId=cus_1&secret=1`))).status).toBe(400);
  });
});

describe("POST /api/gdpr/requests raise", () => {
  beforeEach(() => {
    core.createDataRequest.mockResolvedValue(row({ id: "dr_new", type: "export" }));
  });

  it("records the operator as the requester and never trusts the body for it", async () => {
    const response = await POST(
      request(URL, {
        method: "POST",
        role: "manager",
        body: { customerId: "cus_1", type: "export" },
      }),
    );

    expect(response.status).toBe(201);
    expect(core.createDataRequest).toHaveBeenCalledWith({
      customerId: "cus_1",
      type: "export",
      requestedBy: "manager@hairsimo.it",
    });

    const forged = await POST(
      request(URL, {
        method: "POST",
        body: { customerId: "cus_1", type: "export", requestedBy: "someone.else@example.com" },
      }),
    );
    expect(forged.status).toBe(400);
    expect(core.createDataRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a stylist", async () => {
    const response = await POST(
      request(URL, { method: "POST", role: "staff", body: { customerId: "cus_1", type: "export" } }),
    );
    expect(response.status).toBe(403);
    expect(core.createDataRequest).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("404s an unknown customer before filing anything", async () => {
    db.customerFindUnique.mockResolvedValue(null);
    const response = await POST(
      request(URL, { method: "POST", body: { customerId: "cus_x", type: "erasure" } }),
    );
    expect(response.status).toBe(404);
    expect(core.createDataRequest).not.toHaveBeenCalled();
  });

  it("audits the filing under a gdpr.* action so an erasure cannot redact it later", async () => {
    await POST(request(URL, { method: "POST", body: { customerId: "cus_1", type: "erasure" } }));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "gdpr.request.create",
      entityType: "dataRequest",
      entityId: "dr_new",
      actorEmail: "owner@hairsimo.it",
      actorRole: "owner",
    });
    expect(audits[0].action.startsWith("gdpr.")).toBe(true);
  });

  it("accepts only the two request types the schema knows", () => {
    expect(() => dataRequestCreateSchema.parse({ customerId: "cus_1", type: "delete" })).toThrow();
    expect(() => dataRequestCreateSchema.parse({ customerId: "", type: "export" })).toThrow();
    expect(dataRequestCreateSchema.parse({ customerId: "cus_1", type: "erasure" })).toEqual({
      customerId: "cus_1",
      type: "erasure",
    });
  });
});

describe("gdpr reference vocabulary", () => {
  it("cannot carry an identifier: no address, no bare phone number, no name", () => {
    expect(() => gdprReferenceSchema.parse("anna.bauer@example.com")).toThrow();
    expect(() => gdprReferenceSchema.parse("+39 334 1234567")).toThrow();
    expect(() => gdprReferenceSchema.parse("3341234567")).toThrow();
    expect(() => gdprReferenceSchema.parse("Anna Bauer")).toThrow();
    expect(gdprReferenceSchema.parse("TCK-2026-0031")).toBe("TCK-2026-0031");
  });

  it("renders a reason with its reference", () => {
    expect(reasonPhrase("subject_request", "TCK-1")).toBe("subject_request ref:TCK-1");
    expect(reasonPhrase("subject_request")).toBe("subject_request");
  });
});
