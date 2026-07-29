import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_ID_HEADER,
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  safeMessageForCode,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../lib/admin-api";

const findMany = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({ salonRepository: {} }));

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
  prisma: { callLog: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

function request(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/call-logs${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

beforeEach(() => {
  audits = [];
  setAdminApiLogSink(() => {});
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  resetAdminRateLimits();
  requireSession.mockClear();
  findMany.mockReset();
  findMany.mockResolvedValue([{ id: "call_1", summary: "Intent booking_create" }]);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/call-logs", () => {
  it("rejects a missing session with 401", async () => {
    const response = await GET(request(null));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects a role outside the allowlist with 403", async () => {
    const response = await GET(request("customer"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("pages on a total order and writes no audit row", async () => {
    const response = await GET(request("staff", "?limit=10&offset=30"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pagination: { limit: 10, offset: 30 } });
    expect(findMany).toHaveBeenCalledWith({
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 30,
      take: 10,
    });
    expect(audits).toHaveLength(0);
  });

  it("refuses an unbounded page size and an unknown query parameter", async () => {
    const wide = await GET(request("staff", "?limit=100000"));
    expect(wide.status).toBe(400);
    expect((await wide.json()).details[0].path).toBe("limit");

    const unknown = await GET(request("staff", "?select=fromNumber"));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("VALIDATION_ERROR");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("never leaks a database failure to the browser", async () => {
    findMany.mockRejectedValue(
      new Error(
        "Invalid `prisma.callLog.findMany()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await GET(request("staff"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(JSON.stringify(body)).not.toContain("/app/packages");
  });
});
