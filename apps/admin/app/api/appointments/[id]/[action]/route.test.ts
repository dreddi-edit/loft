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
} from "../../../../../lib/admin-api";

const findAppointmentById = vi.fn();
const updateAppointmentStatus = vi.fn();
const cancel = vi.fn();
const confirm = vi.fn();
const reschedule = vi.fn();
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

vi.mock("../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  BookingService: class {
    cancel = cancel;
    confirm = confirm;
    reschedule = reschedule;
  },
  salonRepository: {
    findAppointmentById: (...args: unknown[]) => findAppointmentById(...args),
    updateAppointmentStatus: (...args: unknown[]) => updateAppointmentStatus(...args),
  },
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

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const BEFORE = {
  id: "apt_1",
  status: "pending",
  startsAt: "2026-08-01T07:00:00.000Z",
  endsAt: "2026-08-01T08:00:00.000Z",
  staffId: "staff_1",
};

const AFTER = { ...BEFORE, status: "cancelled" };

function context(id = "apt_1", action = "cancel") {
  return { params: Promise.resolve({ id, action }) };
}

function request(body: unknown = {}, role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/appointments/apt_1/cancel", {
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
  for (const mock of [
    findAppointmentById,
    updateAppointmentStatus,
    cancel,
    confirm,
    reschedule,
    statusHistoryFindFirst,
    statusHistoryUpdate,
  ]) {
    mock.mockReset();
  }
  findAppointmentById.mockResolvedValue(BEFORE);
  cancel.mockResolvedValue(AFTER);
  confirm.mockResolvedValue({ ...BEFORE, status: "confirmed" });
  reschedule.mockResolvedValue({ ...BEFORE, startsAt: "2026-08-02T07:00:00.000Z" });
  updateAppointmentStatus.mockResolvedValue({ ...BEFORE, status: "completed" });
  statusHistoryFindFirst.mockResolvedValue({ id: "hist_1" });
  statusHistoryUpdate.mockResolvedValue({ id: "hist_1" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("POST /api/appointments/[id]/[action] authorisation", () => {
  it("rejects a missing session with 401 and mutates nothing", async () => {
    const response = await POST(request({}, null), context());
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("rejects a role outside the allowlist with 403", async () => {
    const response = await POST(request({}, "customer"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe("POST /api/appointments/[id]/[action] action dispatch", () => {
  it("acts only on the appointment named in the path", async () => {
    const response = await POST(
      request({ appointmentId: "apt_other" }),
      context("apt_1", "cancel"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels with the supplied reason and audits exactly one row", async () => {
    const response = await POST(request({ reason: "customer called" }), context());
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("apt_1", "customer called");

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "appointment.cancel",
      entityType: "appointment",
      entityId: "apt_1",
      actorId: "usr_1",
    });
    expect(audits[0].before).toMatchObject({ status: "pending" });
    expect(audits[0].after).toMatchObject({ status: "cancelled", reason: "customer called" });
  });

  it("routes confirm, no_show and complete to their own implementation", async () => {
    await POST(request({}), context("apt_1", "confirm"));
    expect(confirm).toHaveBeenCalledExactlyOnceWith("apt_1", "confirmed by staff");

    await POST(request({}), context("apt_1", "no_show"));
    expect(updateAppointmentStatus).toHaveBeenCalledWith("apt_1", "no_show", "marked no-show");

    await POST(request({}), context("apt_1", "complete"));
    expect(updateAppointmentStatus).toHaveBeenCalledWith("apt_1", "completed", "marked completed");
    expect(audits).toHaveLength(3);
  });

  it("rejects an action outside the enum", async () => {
    const response = await POST(request({}), context("apt_1", "delete"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("refuses a reschedule without a new start time and names the field", async () => {
    const response = await POST(request({}), context("apt_1", "reschedule"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe("A new start time is required to reschedule.");
    expect(body.details[0].path).toBe("startsAt");
    expect(reschedule).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("rejects a malformed start time and an unbounded reason", async () => {
    const badStart = await POST(request({ startsAt: "tomorrow" }), context("apt_1", "reschedule"));
    expect(badStart.status).toBe(400);
    expect((await badStart.json()).details[0].path).toBe("startsAt");

    const longReason = await POST(request({ reason: "x".repeat(501) }), context());
    expect(longReason.status).toBe(400);
    expect((await longReason.json()).details[0].path).toBe("reason");
    expect(audits).toHaveLength(0);
  });

  it("returns 404 for an unknown appointment and audits nothing", async () => {
    findAppointmentById.mockResolvedValue(null);
    const response = await POST(request({}), context("apt_missing"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("APPOINTMENT_NOT_FOUND");
    expect(cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("maps a domain refusal onto the taxonomy and audits nothing", async () => {
    reschedule.mockRejectedValue(new Error("SLOT_NOT_AVAILABLE"));
    const response = await POST(
      request({ startsAt: "2026-08-02T07:00:00.000Z" }),
      context("apt_1", "reschedule"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SLOT_NOT_AVAILABLE",
      message: safeMessageForCode("SLOT_NOT_AVAILABLE"),
    });
    expect(audits).toHaveLength(0);
  });

  it("never leaks a Prisma failure to the browser", async () => {
    cancel.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.appointment.update()` invocation in /app/packages/db/src/client.ts:33 " +
            "An operation failed because it depends on one or more records that were required but not found",
        ),
        { code: "P2025" },
      ),
    );

    const response = await POST(request({}), context());
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("/app/packages");
    expect(audits).toHaveLength(0);
  });

  it("still answers when the status history attribution fails", async () => {
    statusHistoryUpdate.mockRejectedValue(new Error("connect ETIMEDOUT 10.8.0.3:5432"));
    const response = await POST(request({}), context());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("ETIMEDOUT");
    expect(audits).toHaveLength(1);
  });
});
