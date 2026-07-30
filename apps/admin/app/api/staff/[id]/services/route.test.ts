import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CODES,
  resetAdminAuditWriter,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../lib/admin-api";

const findStaffById = vi.fn();
const replaceStaffServices = vi.fn();

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
    findStaffById: (...args: unknown[]) => findStaffById(...args),
    replaceStaffServices: (...args: unknown[]) => replaceStaffServices(...args),
  },
}));

const { GET, PUT } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const ERROR_CODE_VALUES: readonly string[] = ERROR_CODES;

let audits: AuditEntry[] = [];

function context(id = "staff_1") {
  return { params: Promise.resolve({ id }) };
}

function build(method: string, role: string | null, body?: unknown): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/staff/staff_1/services", {
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
  findStaffById.mockReset();
  replaceStaffServices.mockReset();
  findStaffById.mockResolvedValue({ id: "staff_1", staffServices: [{ serviceId: "svc_1" }] });
  replaceStaffServices.mockResolvedValue([{ serviceId: "svc_1" }]);
});

afterEach(() => {
  resetAdminAuditWriter();
  vi.restoreAllMocks();
});

describe("GET /api/staff/[id]/services", () => {
  it("refuses an unauthenticated caller and a role outside the allowlist", async () => {
    expect((await GET(build("GET", null), context())).status).toBe(403);
    expect((await GET(build("GET", "customer"), context())).status).toBe(403);
    expect(findStaffById).not.toHaveBeenCalled();
  });

  it("returns the assignment of the staff member named in the path", async () => {
    const response = await GET(build("GET", "staff"), context("staff_7"));
    expect(response.status).toBe(200);
    expect(findStaffById).toHaveBeenCalledExactlyOnceWith("staff_7");
    expect(await response.json()).toEqual({ data: [{ serviceId: "svc_1" }] });
  });

  it("returns 404 for an unknown staff member", async () => {
    findStaffById.mockResolvedValue(null);
    const response = await GET(build("GET", "staff"), context());
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("STAFF_NOT_FOUND");
  });
});

describe("PUT /api/staff/[id]/services", () => {
  it("refuses an unauthenticated caller and a stylist, and writes nothing", async () => {
    expect(
      (await PUT(build("PUT", null, { serviceIds: ["svc_1"] }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await PUT(build("PUT", "staff", { serviceIds: ["svc_1"] }), context())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(replaceStaffServices).not.toHaveBeenCalled();
  });

  it("de-duplicates the assignment and targets the staff member from the path", async () => {
    const response = await PUT(
      build("PUT", "manager", { serviceIds: ["svc_1", "svc_1", "svc_2"] }),
      context("staff_7"),
    );
    expect(response.status).toBe(200);
    expect(replaceStaffServices).toHaveBeenCalledExactlyOnceWith("staff_7", ["svc_1", "svc_2"]);
  });

  it("caps the list and rejects an unknown field", async () => {
    const many = await PUT(
      build("PUT", "manager", { serviceIds: Array.from({ length: 101 }, (_, i) => `svc_${i}`) }),
      context(),
    );
    expect(many.status).toBe(400);

    const unknown = await PUT(
      build("PUT", "manager", { serviceIds: ["svc_1"], staffId: "staff_other" }),
      context(),
    );
    expect(unknown.status).toBe(400);
    expect(replaceStaffServices).not.toHaveBeenCalled();
  });

  /**
   * Characterisation of a route that was never migrated onto adminRoute. See openIssues.
   */
  it("leaks the raw repository message and writes no audit row (KNOWN DEFECT)", async () => {
    replaceStaffServices.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffService.createMany()` invocation in /app/packages/db/src/client.ts:33 " +
          "Foreign key constraint failed on the field: `StaffService_serviceId_fkey`",
      ),
    );

    const response = await PUT(build("PUT", "manager", { serviceIds: ["svc_x"] }), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("StaffService_serviceId_fkey");
    expect(body.error).toContain("/app/packages/db/src/client.ts");
    expect(audits).toHaveLength(0);
  });
});
