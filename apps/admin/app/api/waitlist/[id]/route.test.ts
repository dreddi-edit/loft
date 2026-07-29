import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@hair-simo/db", () => ({
  prisma: { waitlist: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: { createAuditLog: vi.fn() },
  WaitlistService: class {
    cancel = mocks.cancel;
  },
}));

vi.mock("../../../../lib/auth", () => ({
  requireSession: vi.fn(async (request: NextRequest, allowed: string[]) => {
    const role = request.headers.get("x-test-role");
    if (!role) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "usr_1", email: "manager@hairsimo.it", role };
  }),
}));

import {
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../lib/admin-api";
import { DELETE, PATCH, waitlistUpdateSchema } from "./route";

const ACTIVE_ENTRY = {
  id: "wl_1",
  status: "active",
  customerId: "cus_1",
  serviceId: "svc_cut",
  staffId: null,
  earliestAt: new Date("2026-08-03T07:00:00.000Z"),
  latestAt: new Date("2026-08-03T15:00:00.000Z"),
  notifiedAt: null,
  convertedAppointmentId: null,
};

let audits: AuditEntry[] = [];

function context(id = "wl_1") {
  return { params: Promise.resolve({ id }) };
}

function request(
  init: { method?: string; body?: unknown; role?: string | null } = {},
): NextRequest {
  const method = init.method ?? "PATCH";
  const role = init.role === undefined ? "manager" : init.role;
  return new NextRequest("https://admin.hairsimo.it/api/waitlist/wl_1", {
    method,
    headers: {
      ...(role ? { "x-test-role": role } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(() => {
  audits = [];
  setAdminApiLogSink(() => {});
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  resetAdminRateLimits();
  mocks.findUnique.mockReset();
  mocks.updateMany.mockReset();
  mocks.cancel.mockReset();
  mocks.findUnique.mockResolvedValue(ACTIVE_ENTRY);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.cancel.mockResolvedValue({ ...ACTIVE_ENTRY, status: "cancelled" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
});

describe("waitlist update payload", () => {
  it("only accepts the two operator-reachable statuses", () => {
    expect(waitlistUpdateSchema.parse({ status: "expired" })).toEqual({ status: "expired" });
    expect(() => waitlistUpdateSchema.parse({ status: "converted" })).toThrow();
    expect(() =>
      waitlistUpdateSchema.parse({ status: "cancelled", convertedAppointmentId: "apt_1" }),
    ).toThrow();
  });
});

describe("PATCH /api/waitlist/[id]", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await PATCH(request({ body: { status: "cancelled" }, role: null }), context());

    expect(response.status).toBe(401);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("refuses a staff session on a write route", async () => {
    const response = await PATCH(
      request({ body: { status: "cancelled" }, role: "staff" }),
      context(),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("cancels through the service and audits the transition", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(ACTIVE_ENTRY)
      .mockResolvedValueOnce({ ...ACTIVE_ENTRY, status: "cancelled" });

    const response = await PATCH(request({ body: { status: "cancelled" } }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("cancelled");
    expect(mocks.cancel).toHaveBeenCalledWith("wl_1");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "waitlist.cancel",
      entityType: "waitlist",
      entityId: "wl_1",
      actorRole: "manager",
    });
    expect(audits[0].before).toMatchObject({ status: "active" });
    expect(audits[0].after).toMatchObject({ status: "cancelled" });
  });

  it("expires only an entry that is still queued", async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ ...ACTIVE_ENTRY, status: "notified" })
      .mockResolvedValueOnce({ ...ACTIVE_ENTRY, status: "expired" });

    const response = await PATCH(request({ body: { status: "expired" } }), context());

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "wl_1", status: { in: ["active", "notified"] } },
      data: { status: "expired" },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(audits[0].action).toBe("waitlist.expire");
  });

  it("never rewrites a converted entry", async () => {
    mocks.findUnique.mockResolvedValue({
      ...ACTIVE_ENTRY,
      status: "converted",
      convertedAppointmentId: "apt_1",
    });

    const response = await PATCH(request({ body: { status: "cancelled" } }), context());

    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe(
      "A converted waitlist entry can no longer be changed.",
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("refuses to expire a cancelled entry", async () => {
    mocks.findUnique.mockResolvedValue({ ...ACTIVE_ENTRY, status: "cancelled" });

    const response = await PATCH(request({ body: { status: "expired" } }), context());

    expect(response.status).toBe(409);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a body that is not one of the two statuses", async () => {
    const response = await PATCH(request({ body: { status: "active" } }), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for an entry that does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const response = await PATCH(request({ body: { status: "cancelled" } }), context("wl_gone"));

    expect(response.status).toBe(404);
    expect(audits).toHaveLength(0);
  });
});

describe("DELETE /api/waitlist/[id]", () => {
  it("withdraws the entry and audits it", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(ACTIVE_ENTRY)
      .mockResolvedValueOnce({ ...ACTIVE_ENTRY, status: "cancelled" });

    const response = await DELETE(request({ method: "DELETE" }), context());

    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("cancelled");
    expect(mocks.cancel).toHaveBeenCalledWith("wl_1");
    expect(audits[0]).toMatchObject({ action: "waitlist.cancel", entityId: "wl_1" });
  });

  it("refuses a staff session", async () => {
    const response = await DELETE(request({ method: "DELETE", role: "staff" }), context());

    expect(response.status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});
