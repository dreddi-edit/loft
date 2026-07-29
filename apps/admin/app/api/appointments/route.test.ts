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

const listAppointments = vi.fn();
const createBooking = vi.fn();
const statusHistoryFindFirst = vi.fn();
const statusHistoryUpdate = vi.fn();

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
  BookingService: class {
    createBooking = createBooking;
  },
  salonRepository: { listAppointments: (...args: unknown[]) => listAppointments(...args) },
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
    appointmentStatusHistory: {
      findFirst: (...args: unknown[]) => statusHistoryFindFirst(...args),
      update: (...args: unknown[]) => statusHistoryUpdate(...args),
    },
  },
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const APPOINTMENT = {
  id: "apt_1",
  status: "pending",
  startsAt: "2026-08-01T07:00:00.000Z",
  endsAt: "2026-08-01T08:00:00.000Z",
  customerId: "cus_1",
  serviceId: "svc_1",
  staffId: "staff_1",
};

function listRequest(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/appointments${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function createRequest(body: unknown, role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/appointments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    body: JSON.stringify(body),
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
  listAppointments.mockReset();
  createBooking.mockReset();
  statusHistoryFindFirst.mockReset();
  statusHistoryUpdate.mockReset();
  listAppointments.mockResolvedValue([APPOINTMENT]);
  createBooking.mockResolvedValue(APPOINTMENT);
  statusHistoryFindFirst.mockResolvedValue({ id: "hist_1" });
  statusHistoryUpdate.mockResolvedValue({ id: "hist_1" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/appointments", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(listRequest(null))).status).toBe(401);
    expect((await GET(listRequest("customer"))).status).toBe(403);
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("returns a page envelope and writes no audit row", async () => {
    const response = await GET(listRequest("staff", "?limit=10&offset=20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pagination: { limit: 10, offset: 20, count: 1, hasMore: false },
    });
    expect(audits).toHaveLength(0);
  });

  it("rejects an unknown status filter rather than passing it to the database", async () => {
    const response = await GET(listRequest("staff", "?status=confirmed,deleted"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("rejects a malformed range and an unknown query parameter", async () => {
    const range = await GET(listRequest("staff", "?from=yesterday"));
    expect(range.status).toBe(400);
    expect((await range.json()).details[0].path).toBe("from");

    const unknown = await GET(listRequest("staff", "?orderBy=passwordHash"));
    expect(unknown.status).toBe(400);
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("bounds the free-text search", async () => {
    const response = await GET(listRequest("staff", `?query=${"x".repeat(201)}`));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("query");
  });

  it("never leaks a repository failure to the browser", async () => {
    listAppointments.mockRejectedValue(
      new Error(
        "Invalid `prisma.appointment.findMany()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await GET(listRequest("staff"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
  });
});

describe("POST /api/appointments", () => {
  it("rejects a missing session and a wrong role before booking", async () => {
    expect((await POST(createRequest({}, null))).status).toBe(401);
    expect((await POST(createRequest({}, "customer"))).status).toBe(403);
    expect(createBooking).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("creates the booking, attributes the status history and audits once", async () => {
    const response = await POST(createRequest({ serviceSlug: "cut" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: APPOINTMENT });

    expect(statusHistoryUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: "hist_1" },
      data: { changedBy: "usr_1" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "appointment.create",
      entityType: "appointment",
      entityId: "apt_1",
      actorId: "usr_1",
    });
  });

  it("writes no audit row when the booking service refuses the slot", async () => {
    createBooking.mockRejectedValue(new Error("SLOT_NOT_AVAILABLE"));
    const response = await POST(createRequest({ serviceSlug: "cut" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SLOT_NOT_AVAILABLE",
      message: safeMessageForCode("SLOT_NOT_AVAILABLE"),
    });
    expect(audits).toHaveLength(0);
  });

  it("returns 413 for an oversized body", async () => {
    const response = await POST(createRequest({ note: "x".repeat(70_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("never leaks the booking failure to the browser", async () => {
    createBooking.mockRejectedValue(
      new Error(
        "Invalid `prisma.appointment.create()` invocation in /app/packages/db/src/client.ts:33 " +
          "Unique constraint failed on the fields: (`staffId`,`startsAt`)",
      ),
    );
    const response = await POST(createRequest({ serviceSlug: "cut" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error).toBe("INTERNAL");
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Unique constraint");
    expect(audits).toHaveLength(0);
  });
});
