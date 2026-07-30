import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_RATE_LIMIT_POLICIES,
  REQUEST_ID_HEADER,
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  safeMessageForCode,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../lib/admin-api";

const listCustomers = vi.fn();
const createCustomer = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return {
    userId: "usr_1",
    email: "owner@hairsimo.it",
    role,
    firstName: "Simo",
    lastName: "Rossi",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: {
    listCustomers: (...args: unknown[]) => listCustomers(...args),
    createCustomer: (...args: unknown[]) => createCustomer(...args),
  },
}));

const { GET, POST } = await import("./route");

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

const VALID_CREATE = { firstName: "Anna", lastName: "Bianchi", email: "anna@example.com" };

function listRequest(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/customers${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function createRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers", {
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
  listCustomers.mockReset();
  createCustomer.mockReset();
  listCustomers.mockResolvedValue([CUSTOMER]);
  createCustomer.mockResolvedValue(CUSTOMER);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/customers authorisation", () => {
  it("rejects a missing session with 401", async () => {
    const response = await GET(listRequest(null));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: safeMessageForCode("UNAUTHORIZED"),
    });
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("rejects a role outside the allowlist with 403", async () => {
    const response = await GET(listRequest("customer"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "FORBIDDEN",
      message: safeMessageForCode("FORBIDDEN"),
    });
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("admits every staffing role", async () => {
    for (const role of ["owner", "manager", "staff"]) {
      expect((await GET(listRequest(role))).status).toBe(200);
    }
    expect(listCustomers).toHaveBeenCalledTimes(3);
  });

  it("writes no audit row for a read", async () => {
    await GET(listRequest("owner"));
    expect(audits).toHaveLength(0);
  });
});

describe("GET /api/customers pagination", () => {
  it("returns a bounded page envelope", async () => {
    const response = await GET(listRequest("owner", "?limit=25&offset=50"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pagination: { limit: 25, offset: 50, count: 1, hasMore: false },
    });
    expect(listCustomers).toHaveBeenCalledWith({ query: undefined, skip: 50, take: 25 });
  });

  it("refuses a page size or an offset outside the allowed range", async () => {
    const wide = await GET(listRequest("owner", "?limit=5000"));
    expect(wide.status).toBe(400);
    expect((await wide.json()).details[0].path).toBe("limit");

    const deep = await GET(listRequest("owner", "?offset=999999999"));
    expect(deep.status).toBe(400);
    expect((await deep.json()).details[0].path).toBe("offset");
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter instead of silently ignoring it", async () => {
    const response = await GET(listRequest("owner", "?orderBy=passwordHash"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(listCustomers).not.toHaveBeenCalled();
  });
});

describe("POST /api/customers", () => {
  it("rejects a missing session and a wrong role before creating anything", async () => {
    expect((await POST(createRequest(VALID_CREATE, null))).status).toBe(401);
    expect((await POST(createRequest(VALID_CREATE, "customer"))).status).toBe(403);
    expect(createCustomer).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("creates the customer and writes exactly one audit row", async () => {
    const response = await POST(createRequest(VALID_CREATE));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: CUSTOMER });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "customer.create",
      entityType: "customer",
      entityId: "cus_1",
      actorId: "usr_1",
      actorEmail: "owner@hairsimo.it",
      actorRole: "manager",
      ip: "203.0.113.7",
    });
  });

  it("writes no audit row when the mutation is refused", async () => {
    const response = await POST(createRequest({ firstName: "Anna" }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("lastName");
    expect(audits).toHaveLength(0);
  });

  it("rejects mass assignment of server-owned fields", async () => {
    const response = await POST(
      createRequest({ ...VALID_CREATE, id: "cus_hijack", createdAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("bounds every free-text field", async () => {
    const response = await POST(
      createRequest({
        firstName: "a".repeat(101),
        lastName: "b".repeat(101),
        phone: "9".repeat(31),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path).sort(),
    ).toEqual(["firstName", "lastName", "phone"]);
  });

  it("returns 413 for an oversized body", async () => {
    const response = await POST(createRequest({ ...VALID_CREATE, note: "x".repeat(70_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type", async () => {
    const response = await POST(
      new NextRequest("https://admin.hairsimo.it/api/customers", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-test-role": "owner",
        },
        body: "firstName=Anna",
      }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 429 with Retry-After once the mutation policy is exceeded", async () => {
    const definition = ADMIN_RATE_LIMIT_POLICIES.adminMutation;
    const ceiling = definition.limit + (definition.burst ?? 0);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(createRequest(VALID_CREATE))).status).toBe(201);
    }
    const blocked = await POST(createRequest(VALID_CREATE));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
    expect(audits).toHaveLength(ceiling);
  });

  it("never leaks a Prisma constraint name or a stack frame to the browser", async () => {
    const failure = Object.assign(
      new Error(
        "Invalid `prisma.customer.create()` invocation in /app/packages/db/src/client.ts:33 " +
          "Unique constraint failed on the fields: (`email`)",
      ),
      { code: "P2002", meta: { target: ["Customer_email_key"] } },
    );
    createCustomer.mockRejectedValue(failure);

    const response = await POST(createRequest(VALID_CREATE));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Customer_email_key");
    expect(encoded).not.toContain("/app/packages");
    expect(audits).toHaveLength(0);
  });

  it("reports an unmapped failure as INTERNAL without any detail", async () => {
    createCustomer.mockRejectedValue(new Error("connect ETIMEDOUT 10.8.0.3:5432"));
    const response = await POST(createRequest(VALID_CREATE));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("ETIMEDOUT");
  });
});
