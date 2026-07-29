import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CODES,
  resetAdminAuditWriter,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../lib/admin-api";

const listStaffAvailability = vi.fn();
const replaceStaffAvailability = vi.fn();

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
    listStaffAvailability: (...args: unknown[]) => listStaffAvailability(...args),
    replaceStaffAvailability: (...args: unknown[]) => replaceStaffAvailability(...args),
  },
}));

const { GET, PUT } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const ERROR_CODE_VALUES: readonly string[] = ERROR_CODES;

let audits: AuditEntry[] = [];

const RULE = { dayOfWeek: 1, startMin: 540, endMin: 1_080 };

function context(id = "staff_1") {
  return { params: Promise.resolve({ id }) };
}

function build(method: string, role: string | null, body?: unknown): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/staff/staff_1/availability", {
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
  listStaffAvailability.mockReset();
  replaceStaffAvailability.mockReset();
  listStaffAvailability.mockResolvedValue([RULE]);
  replaceStaffAvailability.mockResolvedValue([RULE]);
});

afterEach(() => {
  resetAdminAuditWriter();
  vi.restoreAllMocks();
});

describe("GET /api/staff/[id]/availability", () => {
  it("refuses an unauthenticated caller and a role outside the allowlist", async () => {
    expect((await GET(build("GET", null), context())).status).toBe(403);
    expect((await GET(build("GET", "customer"), context())).status).toBe(403);
    expect(listStaffAvailability).not.toHaveBeenCalled();
  });

  it("returns the rules of the staff member named in the path", async () => {
    const response = await GET(build("GET", "staff"), context("staff_7"));
    expect(response.status).toBe(200);
    expect(listStaffAvailability).toHaveBeenCalledExactlyOnceWith("staff_7");
  });
});

describe("PUT /api/staff/[id]/availability", () => {
  it("refuses an unauthenticated caller and a stylist, and writes nothing", async () => {
    expect(
      (await PUT(build("PUT", null, { rules: [RULE] }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await PUT(build("PUT", "staff", { rules: [RULE] }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(replaceStaffAvailability).not.toHaveBeenCalled();
  });

  it("replaces the rule set for a manager", async () => {
    const response = await PUT(build("PUT", "manager", { rules: [RULE] }), context("staff_7"));
    expect(response.status).toBe(200);
    expect(replaceStaffAvailability).toHaveBeenCalledExactlyOnceWith("staff_7", [RULE]);
  });

  it("caps the number of rules and refuses a window that ends before it starts", async () => {
    const many = await PUT(
      build("PUT", "manager", { rules: Array.from({ length: 101 }, () => RULE) }),
      context(),
    );
    expect(many.status).toBe(400);

    const inverted = await PUT(
      build("PUT", "manager", { rules: [{ dayOfWeek: 1, startMin: 900, endMin: 600 }] }),
      context(),
    );
    expect(inverted.status).toBe(400);

    const outOfRange = await PUT(
      build("PUT", "manager", { rules: [{ dayOfWeek: 9, startMin: 0, endMin: 60 }] }),
      context(),
    );
    expect(outOfRange.status).toBe(400);
    expect(replaceStaffAvailability).not.toHaveBeenCalled();
  });

  it("rejects an unknown field instead of forwarding it", async () => {
    const response = await PUT(
      build("PUT", "manager", { rules: [{ ...RULE, staffId: "staff_other" }] }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(replaceStaffAvailability).not.toHaveBeenCalled();
  });

  /**
   * Characterisation of a route that was never migrated onto adminRoute: the raw
   * repository message reaches the browser, the response carries no taxonomy code and no
   * AuditLog row is written for a mutation. See openIssues.
   */
  it("leaks the raw repository message and writes no audit row (KNOWN DEFECT)", async () => {
    replaceStaffAvailability.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffAvailability.createMany()` invocation in " +
          "/app/packages/db/src/client.ts:33 Foreign key constraint failed on the field: " +
          "`StaffAvailability_staffId_fkey`",
      ),
    );

    const response = await PUT(build("PUT", "manager", { rules: [RULE] }), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("StaffAvailability_staffId_fkey");
    expect(body.error).toContain("/app/packages/db/src/client.ts");
    expect(audits).toHaveLength(0);
  });
});
