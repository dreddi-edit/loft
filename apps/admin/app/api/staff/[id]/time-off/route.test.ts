import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CODES,
  resetAdminAuditWriter,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../lib/admin-api";

const listStaffTimeOff = vi.fn();
const createStaffTimeOff = vi.fn();

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
  salonRepository: {
    listStaffTimeOff: (...args: unknown[]) => listStaffTimeOff(...args),
    createStaffTimeOff: (...args: unknown[]) => createStaffTimeOff(...args),
  },
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const ERROR_CODE_VALUES: readonly string[] = ERROR_CODES;

let audits: AuditEntry[] = [];

const VALID_CREATE = {
  startsAt: "2026-08-10T07:00:00.000Z",
  endsAt: "2026-08-17T07:00:00.000Z",
  reason: "Ferie",
};

function context(id = "staff_1") {
  return { params: Promise.resolve({ id }) };
}

function build(method: string, role: string | null, body?: unknown, query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/staff/staff_1/time-off${query}`, {
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
  listStaffTimeOff.mockReset();
  createStaffTimeOff.mockReset();
  listStaffTimeOff.mockResolvedValue([{ id: "off_1" }]);
  createStaffTimeOff.mockResolvedValue({ id: "off_1" });
});

afterEach(() => {
  resetAdminAuditWriter();
  vi.restoreAllMocks();
});

describe("GET /api/staff/[id]/time-off", () => {
  it("refuses an unauthenticated caller and a role outside the allowlist", async () => {
    expect((await GET(build("GET", null), context())).status).toBe(403);
    expect((await GET(build("GET", "customer"), context())).status).toBe(403);
    expect(listStaffTimeOff).not.toHaveBeenCalled();
  });

  it("reads the range of the staff member named in the path", async () => {
    const response = await GET(
      build(
        "GET",
        "staff",
        undefined,
        "?from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z",
      ),
      context("staff_7"),
    );
    expect(response.status).toBe(200);
    const [staffId, from, to] = listStaffTimeOff.mock.calls[0];
    expect(staffId).toBe("staff_7");
    expect((from as Date).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect((to as Date).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("refuses an unparseable range", async () => {
    const response = await GET(build("GET", "staff", undefined, "?from=whenever"), context());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_DATE_RANGE");
    expect(listStaffTimeOff).not.toHaveBeenCalled();
  });
});

describe("POST /api/staff/[id]/time-off", () => {
  it("refuses an unauthenticated caller and a stylist, and writes nothing", async () => {
    expect(
      (await POST(build("POST", null, VALID_CREATE), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await POST(build("POST", "staff", VALID_CREATE), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(createStaffTimeOff).not.toHaveBeenCalled();
  });

  it("creates the entry for the staff member named in the path", async () => {
    const response = await POST(build("POST", "manager", VALID_CREATE), context("staff_7"));
    expect(response.status).toBe(201);
    const [staffId, input] = createStaffTimeOff.mock.calls[0];
    expect(staffId).toBe("staff_7");
    expect((input as { startsAt: Date }).startsAt.toISOString()).toBe(VALID_CREATE.startsAt);
  });

  it("refuses a range that ends before it starts and an unbounded reason", async () => {
    const inverted = await POST(
      build("POST", "manager", { ...VALID_CREATE, endsAt: "2026-08-01T07:00:00.000Z" }),
      context(),
    );
    expect(inverted.status).toBe(400);

    const longReason = await POST(
      build("POST", "manager", { ...VALID_CREATE, reason: "x".repeat(501) }),
      context(),
    );
    expect(longReason.status).toBe(400);
    expect(createStaffTimeOff).not.toHaveBeenCalled();
  });

  it("rejects an unknown field instead of forwarding it", async () => {
    const response = await POST(
      build("POST", "manager", { ...VALID_CREATE, staffId: "staff_other" }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(createStaffTimeOff).not.toHaveBeenCalled();
  });

  /**
   * Characterisation of a route that was never migrated onto adminRoute. See openIssues.
   */
  it("leaks the raw repository message and writes no audit row (KNOWN DEFECT)", async () => {
    createStaffTimeOff.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffTimeOff.create()` invocation in /app/packages/db/src/client.ts:33 " +
          "Foreign key constraint failed on the field: `StaffTimeOff_staffId_fkey`",
      ),
    );

    const response = await POST(build("POST", "manager", VALID_CREATE), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("StaffTimeOff_staffId_fkey");
    expect(body.error).toContain("/app/packages/db/src/client.ts");
    expect(audits).toHaveLength(0);
  });
});
