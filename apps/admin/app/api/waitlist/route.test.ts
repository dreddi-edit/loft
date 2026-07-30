import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  createAuditLog: vi.fn(),
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

  runWithTenantAsync: async (_ctx: unknown, fn: () => unknown) => fn(), prisma: { waitlist: { findMany: mocks.findMany } } }));

vi.mock("@hair-simo/core", () => ({
  salonRepository: { createAuditLog: mocks.createAuditLog },
}));

vi.mock("../../../lib/auth", () => ({
  requireSession: vi.fn(async (request: NextRequest, allowed: string[]) => {
    const role = request.headers.get("x-test-role");
    if (!role) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "usr_1", email: "owner@hairsimo.it", role,
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen"};
  }),
}));

import {
  MAX_PAGE_SIZE,
  resetAdminApiLogSink,
  resetAdminRateLimits,
  setAdminApiLogSink,
} from "../../../lib/admin-api";
import { GET } from "./route";

const ENTRY = {
  id: "wl_1",
  status: "active",
  earliestAt: new Date("2026-08-03T07:00:00.000Z"),
  latestAt: new Date("2026-08-03T15:00:00.000Z"),
  locale: "it",
  channel: "web",
  notifiedAt: null,
  convertedAppointmentId: null,
  createdAt: new Date("2026-07-29T09:00:00.000Z"),
  customer: {
    id: "cus_1",
    firstName: "Maria",
    lastName: "Rossi",
    email: "maria@example.com",
    phone: null,
  },
  service: { id: "svc_cut", slug: "cut", durationMin: 60, translations: [] },
  staff: null,
};

function request(query = "", role: string | null = "staff"): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/waitlist${query}`, {
    headers: role ? { "x-test-role": role } : {},
  });
}

beforeEach(() => {
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([ENTRY]);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/waitlist", () => {
  it("refuses an unauthenticated caller before reading anything", async () => {
    const response = await GET(request("", null));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("lets the whole team read the queue oldest first with a total sort", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 1, hasMore: false });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: 0,
        take: 50,
      }),
    );
  });

  it("filters by status, service and staff", async () => {
    await GET(request("?status=notified&serviceId=svc_cut&staffId=stf_1&limit=10&offset=20"));

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "notified", serviceId: "svc_cut", staffId: "stf_1" },
        skip: 20,
        take: 10,
      }),
    );
  });

  it("caps the page size and rejects an unknown status", async () => {
    const tooLarge = await GET(request(`?limit=${MAX_PAGE_SIZE + 1}`));
    expect(tooLarge.status).toBe(400);
    expect((await tooLarge.json()).details[0].path).toBe("limit");

    const badStatus = await GET(request("?status=whatever"));
    expect(badStatus.status).toBe(400);

    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter instead of ignoring it", async () => {
    const response = await GET(request("?customerId=cus_1"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("reports hasMore when a full page comes back", async () => {
    mocks.findMany.mockResolvedValue([ENTRY, ENTRY]);
    const body = await (await GET(request("?limit=2"))).json();
    expect(body.pagination).toEqual({ limit: 2, offset: 0, count: 2, hasMore: true });
  });
});
