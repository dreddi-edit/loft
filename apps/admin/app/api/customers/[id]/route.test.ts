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
} from "../../../../lib/admin-api";

const findCustomerById = vi.fn();
const updateCustomer = vi.fn();
const addCustomerNote = vi.fn();

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
    findCustomerById: (...args: unknown[]) => findCustomerById(...args),
    updateCustomer: (...args: unknown[]) => updateCustomer(...args),
    addCustomerNote: (...args: unknown[]) => addCustomerNote(...args),
  },
}));

const { GET, PATCH, customerUpdateSchema } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const CUSTOMER = {
  id: "cus_1",
  firstName: "Anna",
  lastName: "Bianchi",
  email: "anna@example.com",
  phone: null,
  locale: "it",
  marketingOptIn: false,
};

function context(id = "cus_1") {
  return { params: Promise.resolve({ id }) };
}

function getRequest(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers/cus_1", {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function patchRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers/cus_1", {
    method: "PATCH",
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
  findCustomerById.mockReset();
  updateCustomer.mockReset();
  addCustomerNote.mockReset();
  findCustomerById.mockResolvedValue(CUSTOMER);
  updateCustomer.mockResolvedValue({ ...CUSTOMER, firstName: "Annamaria" });
  addCustomerNote.mockResolvedValue({ id: "note_1" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("customer update allowlist", () => {
  it("rejects mass-assignment fields", () => {
    expect(() =>
      customerUpdateSchema.parse({
        firstName: "Simo",
        sourceChannel: "voice",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("accepts supported profile fields and a note", () => {
    expect(
      customerUpdateSchema.parse({
        email: "customer@example.com",
        marketingOptIn: true,
        note: "Prefers morning appointments",
      }),
    ).toEqual({
      email: "customer@example.com",
      marketingOptIn: true,
      note: "Prefers morning appointments",
    });
  });
});

describe("GET /api/customers/[id]", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    const anonymous = await GET(getRequest(null), context());
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error).toBe("UNAUTHORIZED");

    const wrongRole = await GET(getRequest("customer"), context());
    expect(wrongRole.status).toBe(403);
    expect((await wrongRole.json()).error).toBe("FORBIDDEN");
    expect(findCustomerById).not.toHaveBeenCalled();
  });

  it("returns the customer and writes no audit row", async () => {
    const response = await GET(getRequest("staff"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: CUSTOMER });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 with a safe message for an unknown id", async () => {
    findCustomerById.mockResolvedValue(null);
    const response = await GET(getRequest("staff"), context("cus_missing"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("cus_missing");
  });
});

describe("PATCH /api/customers/[id]", () => {
  it("rejects a missing session and a wrong role before touching the record", async () => {
    expect((await PATCH(patchRequest({ firstName: "X" }, null), context())).status).toBe(401);
    expect((await PATCH(patchRequest({ firstName: "X" }, "customer"), context())).status).toBe(403);
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("writes exactly one audit row carrying the before and after snapshot", async () => {
    const response = await PATCH(patchRequest({ firstName: "Annamaria" }), context());
    expect(response.status).toBe(200);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "customer.update",
      entityType: "customer",
      entityId: "cus_1",
      actorId: "usr_1",
      actorRole: "manager",
    });
    expect(audits[0].before).toMatchObject({ firstName: "Anna" });
    expect(audits[0].after).toMatchObject({ firstName: "Annamaria" });
  });

  it("records a note through the note table rather than as a customer column", async () => {
    await PATCH(patchRequest({ note: "Allergic to ammonia" }), context());
    expect(addCustomerNote).toHaveBeenCalledExactlyOnceWith("cus_1", "Allergic to ammonia", {
      authorId: "usr_1",
    });
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(audits[0].after).toMatchObject({ noteAdded: true });
  });

  it("refuses an unknown field and writes no audit row", async () => {
    const response = await PATCH(patchRequest({ firstName: "X", role: "owner" }), context());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("returns 404 for an unknown customer without auditing a phantom mutation", async () => {
    findCustomerById.mockResolvedValue(null);
    const response = await PATCH(patchRequest({ firstName: "X" }), context("cus_missing"));
    expect(response.status).toBe(404);
    expect(audits).toHaveLength(0);
  });

  it("never leaks a Prisma failure to the browser", async () => {
    updateCustomer.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.customer.update()` invocation in /app/packages/db/src/client.ts:33 " +
            "Unique constraint failed on the fields: (`email`)",
        ),
        { code: "P2002" },
      ),
    );

    const response = await PATCH(patchRequest({ email: "taken@example.com" }), context());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Unique constraint");
    expect(encoded).not.toContain("/app/packages");
  });
});
