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
} from "../../../lib/admin-api";

const listServices = vi.fn();
const createService = vi.fn();

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
  salonRepository: {
    listServices: (...args: unknown[]) => listServices(...args),
    createService: (...args: unknown[]) => createService(...args),
  },
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const SERVICE = {
  id: "svc_1",
  slug: "damen-schnitt",
  category: "cut",
  durationMin: 45,
  bufferAfterMin: 10,
  priceCents: 4_500,
};

const VALID_CREATE = {
  slug: "damen-schnitt",
  category: "cut",
  durationMin: 45,
  priceCents: 4_500,
  translations: [{ locale: "de", name: "Damenschnitt", description: "Waschen, schneiden" }],
};

function getRequest(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/services", {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function postRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/services", {
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
  listServices.mockReset();
  createService.mockReset();
  listServices.mockResolvedValue([SERVICE]);
  createService.mockResolvedValue(SERVICE);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/services", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(getRequest(null))).status).toBe(401);
    expect((await GET(getRequest("customer"))).status).toBe(403);
    expect(listServices).not.toHaveBeenCalled();
  });

  it("includes inactive services for the backoffice and writes no audit row", async () => {
    const response = await GET(getRequest("staff"));
    expect(response.status).toBe(200);
    expect(listServices).toHaveBeenCalledExactlyOnceWith(true);
    expect(audits).toHaveLength(0);
  });
});

describe("POST /api/services", () => {
  it("is closed to the staff role", async () => {
    expect((await POST(postRequest(VALID_CREATE, null))).status).toBe(401);
    expect((await POST(postRequest(VALID_CREATE, "staff"))).status).toBe(403);
    expect(createService).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("creates the service and writes exactly one audit row", async () => {
    const response = await POST(postRequest(VALID_CREATE));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: SERVICE });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "service.create",
      entityType: "service",
      entityId: "svc_1",
    });
    expect(audits[0].after).toMatchObject({ slug: "damen-schnitt", priceCents: 4_500 });
  });

  it("enforces a URL-safe slug because it is the public booking key", async () => {
    for (const slug of ["Damen Schnitt", "../admin", "damen_schnitt", "-leading"]) {
      const response = await POST(postRequest({ ...VALID_CREATE, slug }));
      expect(response.status, slug).toBe(400);
      expect((await response.json()).details[0].path).toBe("slug");
    }
    expect(createService).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("requires at least one translation and caps the number of locales", async () => {
    const none = await POST(postRequest({ ...VALID_CREATE, translations: [] }));
    expect(none.status).toBe(400);
    expect((await none.json()).details[0].path).toBe("translations");

    const many = await POST(
      postRequest({
        ...VALID_CREATE,
        translations: Array.from({ length: 5 }, () => VALID_CREATE.translations[0]),
      }),
    );
    expect(many.status).toBe(400);
    expect(createService).not.toHaveBeenCalled();
  });

  it("bounds the duration and the buffer so a service cannot block a whole week", async () => {
    const duration = await POST(postRequest({ ...VALID_CREATE, durationMin: 5_000 }));
    expect(duration.status).toBe(400);
    expect((await duration.json()).details[0].path).toBe("durationMin");

    const buffer = await POST(postRequest({ ...VALID_CREATE, bufferAfterMin: 1_000 }));
    expect(buffer.status).toBe(400);
    expect((await buffer.json()).details[0].path).toBe("bufferAfterMin");
  });

  it("rejects an unknown field instead of forwarding it to the repository", async () => {
    const response = await POST(postRequest({ ...VALID_CREATE, id: "svc_hijack" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(createService).not.toHaveBeenCalled();
  });

  it("never leaks a unique constraint name to the browser", async () => {
    createService.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.service.create()` invocation in /app/packages/db/src/client.ts:33 " +
            "Unique constraint failed on the fields: (`slug`)",
        ),
        { code: "P2002", meta: { target: ["Service_slug_key"] } },
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
    expect(encoded).not.toContain("Service_slug_key");
    expect(encoded).not.toContain("prisma");
    expect(audits).toHaveLength(0);
  });
});
