import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { getMetrics } = vi.hoisted(() => ({ getMetrics: vi.fn() }));

vi.mock("@hair-simo/core", () => ({
  ReviewRequestService: class {
    getMetrics = getMetrics;
  },
  salonRepository: { createAuditLog: vi.fn() },
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
  resetAdminRateLimits,
  setAdminApiLogSink,
} from "../../../../lib/admin-api";
import { GET } from "./route";

const URL = "https://admin.hairsimo.it/api/reviews/metrics";

const METRICS = {
  sent: 12,
  clicked: 4,
  clickRate: 0.333,
  skippedNoConsent: 2,
  skippedCooldown: 1,
  skippedLifetimeCap: 0,
};

function request(query = "", role: RoleKey | null = "staff"): NextRequest {
  return new NextRequest(`${URL}${query}`, {
    headers: role ? { "x-test-role": role } : {},
  });
}

beforeEach(() => {
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  getMetrics.mockReset();
  getMetrics.mockResolvedValue(METRICS);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/reviews/metrics auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await GET(request("", null));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(getMetrics).not.toHaveBeenCalled();
  });

  it("admits the whole team", async () => {
    expect((await GET(request("", "staff"))).status).toBe(200);
    expect((await GET(request("", "manager"))).status).toBe(200);
  });
});

describe("GET /api/reviews/metrics", () => {
  it("returns aggregated review-request metrics", async () => {
    const body = await (await GET(request())).json();

    expect(body.data).toEqual(METRICS);
    expect(getMetrics).toHaveBeenCalledWith({});
  });

  it("passes optional range and locale filters to the service", async () => {
    await GET(request("?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z&locale=it"));

    expect(getMetrics).toHaveBeenCalledWith({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-31T23:59:59.000Z"),
      locale: "it",
    });
  });

  it("rejects an unknown query parameter", async () => {
    const response = await GET(request("?staffId=stf_1"));
    expect(response.status).toBe(400);
    expect(getMetrics).not.toHaveBeenCalled();
  });
});
