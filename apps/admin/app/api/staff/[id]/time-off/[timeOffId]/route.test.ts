import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CODES,
  resetAdminAuditWriter,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../../lib/admin-api";

const findStaffTimeOff = vi.fn();
const updateStaffTimeOff = vi.fn();
const deleteStaffTimeOff = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: {
    findStaffTimeOff: (...args: unknown[]) => findStaffTimeOff(...args),
    updateStaffTimeOff: (...args: unknown[]) => updateStaffTimeOff(...args),
    deleteStaffTimeOff: (...args: unknown[]) => deleteStaffTimeOff(...args),
  },
}));

const { PATCH, DELETE } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const ERROR_CODE_VALUES: readonly string[] = ERROR_CODES;

let audits: AuditEntry[] = [];

const EXISTING = {
  id: "off_1",
  startsAt: new Date("2026-08-10T07:00:00.000Z"),
  endsAt: new Date("2026-08-17T07:00:00.000Z"),
  reason: "Ferie",
};

function context(id = "staff_1", timeOffId = "off_1") {
  return { params: Promise.resolve({ id, timeOffId }) };
}

function build(method: string, role: string | null, body?: unknown): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/staff/staff_1/time-off/off_1", {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  audits = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  requireSession.mockClear();
  findStaffTimeOff.mockReset();
  updateStaffTimeOff.mockReset();
  deleteStaffTimeOff.mockReset();
  findStaffTimeOff.mockResolvedValue(EXISTING);
  updateStaffTimeOff.mockResolvedValue({ ...EXISTING, reason: "Malattia" });
  deleteStaffTimeOff.mockResolvedValue({ id: "off_1" });
});

afterEach(() => {
  resetAdminAuditWriter();
  vi.restoreAllMocks();
});

describe("PATCH /api/staff/[id]/time-off/[timeOffId]", () => {
  it("refuses an unauthenticated caller and a stylist, and writes nothing", async () => {
    expect(
      (await PATCH(build("PATCH", null, { reason: "x" }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await PATCH(build("PATCH", "staff", { reason: "x" }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(updateStaffTimeOff).not.toHaveBeenCalled();
  });

  it("scopes the lookup to both the staff member and the entry from the path", async () => {
    await PATCH(build("PATCH", "manager", { reason: "Malattia" }), context("staff_7", "off_9"));
    expect(findStaffTimeOff).toHaveBeenCalledExactlyOnceWith("staff_7", "off_9");
    expect(updateStaffTimeOff.mock.calls[0].slice(0, 2)).toEqual(["staff_7", "off_9"]);
  });

  it("returns 404 when the entry does not belong to that staff member", async () => {
    findStaffTimeOff.mockResolvedValue(null);
    const response = await PATCH(build("PATCH", "manager", { reason: "x" }), context());
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("TIME_OFF_NOT_FOUND");
    expect(updateStaffTimeOff).not.toHaveBeenCalled();
  });

  it("refuses a patch that would invert the range against the stored values", async () => {
    const response = await PATCH(
      build("PATCH", "manager", { endsAt: "2026-08-01T07:00:00.000Z" }),
      context(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_TIME_RANGE");
    expect(updateStaffTimeOff).not.toHaveBeenCalled();
  });

  it("rejects an unknown field and a malformed instant", async () => {
    const unknown = await PATCH(build("PATCH", "manager", { staffId: "staff_other" }), context());
    expect(unknown.status).toBe(400);

    const malformed = await PATCH(build("PATCH", "manager", { startsAt: "tomorrow" }), context());
    expect(malformed.status).toBe(400);
    expect(updateStaffTimeOff).not.toHaveBeenCalled();
  });

  /**
   * Characterisation of a route that was never migrated onto adminRoute. See openIssues.
   */
  it("leaks the raw repository message and writes no audit row (KNOWN DEFECT)", async () => {
    updateStaffTimeOff.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffTimeOff.update()` invocation in /app/packages/db/src/client.ts:33 " +
          "An operation failed because it depends on one or more records that were required but not found",
      ),
    );

    const response = await PATCH(build("PATCH", "manager", { reason: "Malattia" }), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("/app/packages/db/src/client.ts");
    expect(audits).toHaveLength(0);
  });
});

describe("DELETE /api/staff/[id]/time-off/[timeOffId]", () => {
  it("refuses an unauthenticated caller and a stylist", async () => {
    expect((await DELETE(build("DELETE", null), context())).status).toBeGreaterThanOrEqual(400);
    expect((await DELETE(build("DELETE", "staff"), context())).status).toBeGreaterThanOrEqual(400);
    expect(deleteStaffTimeOff).not.toHaveBeenCalled();
  });

  it("scopes the delete to both path segments and writes no audit row (KNOWN DEFECT)", async () => {
    const response = await DELETE(build("DELETE", "manager"), context("staff_7", "off_9"));
    expect(response.status).toBe(200);
    expect(deleteStaffTimeOff).toHaveBeenCalledExactlyOnceWith("staff_7", "off_9");
    expect(audits).toHaveLength(0);
  });

  it("leaks the raw repository message on failure (KNOWN DEFECT)", async () => {
    deleteStaffTimeOff.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffTimeOff.delete()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await DELETE(build("DELETE", "manager"), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("/app/packages/db/src/client.ts");
  });
});
