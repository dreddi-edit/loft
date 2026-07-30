import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const listAuditLog = vi.fn();

vi.mock("@hair-simo/core", () => ({
  salonRepository: { listAuditLog: (...args: unknown[]) => listAuditLog(...args) },
}));

vi.mock("../../../lib/auth", () => ({
  requireSession: async (request: NextRequest, allowed: RoleKey[]): Promise<AuthSession> => {
    const role = request.headers.get("x-test-role") as RoleKey | null;
    if (!role) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "B",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
  },
}));

import {
  MAX_PAGE_SIZE,
  resetAdminApiLogSink,
  resetAdminRateLimits,
  setAdminApiLogSink,
} from "../../../lib/admin-api";
import { GET } from "./route";

const ENTRY = {
  id: "aud_1",
  actorId: "usr_1",
  actorEmail: "owner@hairsimo.it",
  actorRole: "owner",
  action: "appointment.cancel",
  entityType: "appointment",
  entityId: "apt_1",
  before: null,
  after: { status: "cancelled" },
  ip: "203.0.113.7",
  userAgent: "vitest",
  createdAt: new Date("2026-07-29T09:00:00.000Z"),
};

function request(query = "", role: RoleKey | null = "owner"): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/audit-log${query}`, {
    headers: role ? { "x-test-role": role } : {},
  });
}

beforeEach(() => {
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  listAuditLog.mockReset();
  listAuditLog.mockResolvedValue([ENTRY]);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/audit-log auth boundary", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await GET(request("", null));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(listAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a stylist: the log names every operator action", async () => {
    const response = await GET(request("", "staff"));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(listAuditLog).not.toHaveBeenCalled();
  });

  it("admits a manager", async () => {
    expect((await GET(request("", "manager"))).status).toBe(200);
  });
});

describe("GET /api/audit-log", () => {
  it("returns paginated rows newest-first by default", async () => {
    const body = await (await GET(request())).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].action).toBe("appointment.cancel");
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 1, hasMore: false });
    expect(listAuditLog).toHaveBeenCalledWith({}, { skip: 0, take: 50 });
  });

  it("passes filters straight to the repository", async () => {
    await GET(
      request(
        "?actorId=usr_1&action=appointment.cancel&entityType=appointment&entityId=apt_1&from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z&limit=10&offset=5",
      ),
    );

    expect(listAuditLog).toHaveBeenCalledWith(
      {
        actorId: "usr_1",
        action: "appointment.cancel",
        entityType: "appointment",
        entityId: "apt_1",
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-07-31T23:59:59.000Z"),
      },
      { skip: 5, take: 10 },
    );
  });

  it("caps the page size and rejects unknown query parameters", async () => {
    expect((await GET(request(`?limit=${MAX_PAGE_SIZE + 1}`))).status).toBe(400);
    expect((await GET(request("?customerId=cus_1"))).status).toBe(400);
    expect(listAuditLog).not.toHaveBeenCalled();
  });

  it("reports hasMore when a full page comes back", async () => {
    listAuditLog.mockResolvedValue([ENTRY, ENTRY]);
    const body = await (await GET(request("?limit=2"))).json();
    expect(body.pagination).toEqual({ limit: 2, offset: 0, count: 2, hasMore: true });
  });
});
