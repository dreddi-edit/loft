import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_RATE_LIMIT_POLICIES,
  REQUEST_ID_HEADER,
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  safeMessageForCode,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../lib/admin-api";

const getDashboardStats = vi.fn();

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

vi.mock("@hair-simo/core", () => ({
  salonRepository: { getDashboardStats: (...args: unknown[]) => getDashboardStats(...args) },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

function request(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/dashboard", {
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
  getDashboardStats.mockReset();
  getDashboardStats.mockResolvedValue({ appointmentsToday: 4, revenueCents: 32_000 });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/dashboard", () => {
  it("rejects a missing session with 401", async () => {
    const response = await GET(request(null));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(getDashboardStats).not.toHaveBeenCalled();
  });

  it("rejects a role outside the allowlist with 403", async () => {
    const response = await GET(request("customer"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(getDashboardStats).not.toHaveBeenCalled();
  });

  it("returns the stats and writes no audit row", async () => {
    const response = await GET(request("staff"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { appointmentsToday: 4, revenueCents: 32_000 },
    });
    expect(audits).toHaveLength(0);
  });

  it("bounds a stolen session with the read policy and answers 429 with Retry-After", async () => {
    const definition = ADMIN_RATE_LIMIT_POLICIES.adminRead;
    const ceiling = definition.limit + (definition.burst ?? 0);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await GET(request("staff"))).status).toBe(200);
    }
    const blocked = await GET(request("staff"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("never leaks a repository failure to the browser", async () => {
    getDashboardStats.mockRejectedValue(
      new Error('relation "Appointment" does not exist at /app/packages/db/src/client.ts:33'),
    );
    const response = await GET(request("staff"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("does not exist");
    expect(JSON.stringify(body)).not.toContain("/app/packages");
  });
});
