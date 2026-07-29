import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CODES,
  resetAdminAuditWriter,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../lib/admin-api";

const findStaffById = vi.fn();
const updateStaffUser = vi.fn();
const updateStaffProfile = vi.fn();
const deleteStaff = vi.fn();
const transaction = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: {
    findStaffById: (...args: unknown[]) => findStaffById(...args),
    updateStaffUser: (...args: unknown[]) => updateStaffUser(...args),
    updateStaffProfile: (...args: unknown[]) => updateStaffProfile(...args),
    deleteStaff: (...args: unknown[]) => deleteStaff(...args),
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
  prisma: { $transaction: (...args: unknown[]) => transaction(...args) },
}));

const { GET, PATCH, DELETE } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const ERROR_CODE_VALUES: readonly string[] = ERROR_CODES;

let audits: AuditEntry[] = [];

const STAFF = { id: "staff_1", userId: "usr_9", displayName: "Simo", staffServices: [] };

function context(id = "staff_1") {
  return { params: Promise.resolve({ id }) };
}

function build(method: string, role: string | null, body?: unknown): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/staff/staff_1", {
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
  updateStaffUser.mockReset();
  updateStaffProfile.mockReset();
  deleteStaff.mockReset();
  transaction.mockReset();
  findStaffById.mockResolvedValue(STAFF);
  updateStaffUser.mockResolvedValue(STAFF);
  updateStaffProfile.mockResolvedValue(STAFF);
  deleteStaff.mockResolvedValue(STAFF);
  transaction.mockResolvedValue(undefined);
});

afterEach(() => {
  resetAdminAuditWriter();
  vi.restoreAllMocks();
});

describe("GET /api/staff/[id]", () => {
  it("refuses an unauthenticated caller and reads nothing", async () => {
    const response = await GET(build("GET", null), context());
    expect(response.status).toBe(403);
    expect(findStaffById).not.toHaveBeenCalled();
  });

  it("refuses a role outside the allowlist", async () => {
    const response = await GET(build("GET", "customer"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(findStaffById).not.toHaveBeenCalled();
  });

  it("returns the record for a staffing role", async () => {
    const response = await GET(build("GET", "staff"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: STAFF });
  });

  it("returns 404 for an unknown id", async () => {
    findStaffById.mockResolvedValue(null);
    const response = await GET(build("GET", "staff"), context("staff_missing"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("STAFF_NOT_FOUND");
  });
});

describe("PATCH /api/staff/[id]", () => {
  it("refuses an unauthenticated caller and a stylist, and mutates nothing", async () => {
    const anonymous = await PATCH(build("PATCH", null, { displayName: "X" }), context());
    expect(anonymous.status).toBeGreaterThanOrEqual(400);

    const stylist = await PATCH(build("PATCH", "staff", { role: "owner" }), context());
    expect(stylist.status).toBeGreaterThanOrEqual(400);

    expect(updateStaffUser).not.toHaveBeenCalled();
    expect(updateStaffProfile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown field instead of forwarding it", async () => {
    const response = await PATCH(
      build("PATCH", "owner", { passwordHash: "$2b$12$injected" }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(updateStaffUser).not.toHaveBeenCalled();
  });

  it("splits the payload between the user row and the profile row", async () => {
    await PATCH(build("PATCH", "owner", { email: "new@hairsimo.it", bio: "Hi" }), context());
    expect(updateStaffUser).toHaveBeenCalledWith("usr_9", { email: "new@hairsimo.it" });
    expect(updateStaffProfile).toHaveBeenCalledWith("staff_1", { bio: "Hi" });
  });

  it("returns 404 for an unknown staff member", async () => {
    findStaffById.mockResolvedValue(null);
    const response = await PATCH(build("PATCH", "owner", { bio: "Hi" }), context());
    expect(response.status).toBe(404);
    expect(updateStaffUser).not.toHaveBeenCalled();
  });

  /**
   * Characterisation of a route that was never migrated onto adminRoute. Both assertions
   * describe defects, not intended behaviour: the raw repository message reaches the
   * browser and a role change leaves no AuditLog row. See openIssues.
   */
  it("leaks the raw repository message and writes no audit row (KNOWN DEFECT)", async () => {
    updateStaffProfile.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffProfile.update()` invocation in /app/packages/db/src/client.ts:33 " +
          "Unique constraint failed on the fields: (`displayName`)",
      ),
    );

    const response = await PATCH(build("PATCH", "owner", { displayName: "Simo" }), context());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(ERROR_CODE_VALUES).not.toContain(body.error);
    expect(body.error).toContain("Unique constraint failed");
    expect(body.error).toContain("/app/packages/db/src/client.ts");
    expect(audits).toHaveLength(0);
  });

  it("lets a manager grant a role without leaving an audit trail (KNOWN DEFECT)", async () => {
    const response = await PATCH(build("PATCH", "manager", { role: "owner" }), context());
    expect(response.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(0);
  });
});

describe("DELETE /api/staff/[id]", () => {
  it("refuses an unauthenticated caller and a stylist", async () => {
    expect((await DELETE(build("DELETE", null), context())).status).toBeGreaterThanOrEqual(400);
    expect((await DELETE(build("DELETE", "staff"), context())).status).toBeGreaterThanOrEqual(400);
    expect(deleteStaff).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown staff member", async () => {
    findStaffById.mockResolvedValue(null);
    const response = await DELETE(build("DELETE", "owner"), context());
    expect(response.status).toBe(404);
    expect(deleteStaff).not.toHaveBeenCalled();
  });

  it("deletes the record named in the path and writes no audit row (KNOWN DEFECT)", async () => {
    const response = await DELETE(build("DELETE", "owner"), context("staff_1"));
    expect(response.status).toBe(200);
    expect(deleteStaff).toHaveBeenCalledExactlyOnceWith("staff_1");
    expect(audits).toHaveLength(0);
  });
});
