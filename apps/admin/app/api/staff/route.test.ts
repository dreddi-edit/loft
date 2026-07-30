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

const listStaff = vi.fn();
const createStaff = vi.fn();
const hashPassword = vi.fn();

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
  hashPassword: (...args: unknown[]) => hashPassword(...args),
  salonRepository: {
    listStaff: (...args: unknown[]) => listStaff(...args),
    createStaff: (...args: unknown[]) => createStaff(...args),
  },
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const STAFF = { id: "staff_1", displayName: "Simo", userId: "usr_9" };

const VALID_CREATE = {
  email: "new@hairsimo.it",
  password: "a-very-long-password",
  firstName: "Nuova",
  lastName: "Collega",
  displayName: "Nuova",
};

function getRequest(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/staff${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function postRequest(body: unknown, role: string | null = "owner"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/staff", {
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
  listStaff.mockReset();
  createStaff.mockReset();
  hashPassword.mockReset();
  listStaff.mockResolvedValue([STAFF]);
  createStaff.mockResolvedValue(STAFF);
  hashPassword.mockResolvedValue("$2b$12$hashed");
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/staff", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(getRequest(null))).status).toBe(401);
    expect((await GET(getRequest("customer"))).status).toBe(403);
    expect(listStaff).not.toHaveBeenCalled();
  });

  it("returns a page envelope and writes no audit row", async () => {
    const response = await GET(getRequest("staff", "?isBookable=true&limit=10"));
    expect(response.status).toBe(200);
    expect(listStaff).toHaveBeenCalledWith({
      query: undefined,
      isBookable: true,
      skip: 0,
      take: 10,
    });
    expect(audits).toHaveLength(0);
  });

  it("rejects a non-boolean filter and an unknown query parameter", async () => {
    const filter = await GET(getRequest("staff", "?isBookable=maybe"));
    expect(filter.status).toBe(400);
    expect((await filter.json()).details[0].path).toBe("isBookable");

    const unknown = await GET(getRequest("staff", "?select=passwordHash"));
    expect(unknown.status).toBe(400);
    expect(listStaff).not.toHaveBeenCalled();
  });
});

describe("POST /api/staff", () => {
  it("is closed to the staff role, so a stylist cannot mint an owner account", async () => {
    expect((await POST(postRequest(VALID_CREATE, null))).status).toBe(401);
    const staff = await POST(postRequest({ ...VALID_CREATE, role: "owner" }, "staff"));
    expect(staff.status).toBe(403);
    expect((await staff.json()).error).toBe("FORBIDDEN");
    expect(createStaff).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("hashes the password before it reaches the repository", async () => {
    const response = await POST(postRequest(VALID_CREATE));
    expect(response.status).toBe(201);
    expect(hashPassword).toHaveBeenCalledExactlyOnceWith("a-very-long-password");
    const [payload] = createStaff.mock.calls[0];
    expect(payload.passwordHash).toBe("$2b$12$hashed");
  });

  it("keeps the password out of the audit row", async () => {
    await POST(postRequest(VALID_CREATE));
    expect(audits).toHaveLength(1);
    const encoded = JSON.stringify(audits[0]);
    expect(encoded).not.toContain("a-very-long-password");
    expect(encoded).not.toContain("$2b$12$hashed");
    expect(audits[0]).toMatchObject({
      action: "staff.create",
      entityType: "staff",
      entityId: "staff_1",
    });
  });

  it("keeps the password and the hash out of the response", async () => {
    const encoded = JSON.stringify(await (await POST(postRequest(VALID_CREATE))).json());
    expect(encoded).not.toContain("a-very-long-password");
    expect(encoded).not.toContain("$2b$12$hashed");
  });

  it("refuses a short password and an invalid email", async () => {
    const short = await POST(postRequest({ ...VALID_CREATE, password: "short" }));
    expect(short.status).toBe(400);
    const shortBody = await short.json();
    expect(shortBody.details[0].path).toBe("password");
    expect(JSON.stringify(shortBody)).not.toContain("short");

    const email = await POST(postRequest({ ...VALID_CREATE, email: "not-an-email" }));
    expect(email.status).toBe(400);
    expect((await email.json()).details[0].path).toBe("email");
    expect(createStaff).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("rejects a role outside the three admin roles", async () => {
    const response = await POST(postRequest({ ...VALID_CREATE, role: "superuser" }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("role");
    expect(createStaff).not.toHaveBeenCalled();
  });

  it("rejects an unknown field instead of forwarding it to the repository", async () => {
    const response = await POST(postRequest({ ...VALID_CREATE, passwordHash: "$2b$12$injected" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(createStaff).not.toHaveBeenCalled();
  });

  it("is bounded by the sensitive policy", async () => {
    const definition = ADMIN_RATE_LIMIT_POLICIES.adminSensitive;
    const ceiling = definition.limit + (definition.burst ?? 0);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(postRequest(VALID_CREATE))).status).toBe(201);
    }
    const blocked = await POST(postRequest(VALID_CREATE));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(audits).toHaveLength(ceiling);
  });

  it("never leaks a unique constraint name to the browser", async () => {
    createStaff.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.user.create()` invocation in /app/packages/db/src/client.ts:33 " +
            "Unique constraint failed on the fields: (`email`)",
        ),
        { code: "P2002", meta: { target: ["User_email_key"] } },
      ),
    );

    const response = await POST(postRequest(VALID_CREATE));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("User_email_key");
    expect(encoded).not.toContain("prisma");
    expect(audits).toHaveLength(0);
  });
});
