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

const findServiceById = vi.fn();
const updateService = vi.fn();
const upsertServiceTranslation = vi.fn();

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
    findServiceById: (...args: unknown[]) => findServiceById(...args),
    updateService: (...args: unknown[]) => updateService(...args),
    upsertServiceTranslation: (...args: unknown[]) => upsertServiceTranslation(...args),
  },
}));

const { GET, PATCH } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const SERVICE = {
  id: "svc_1",
  slug: "damen-schnitt",
  category: "cut",
  durationMin: 45,
  bufferAfterMin: 10,
  priceCents: 4_500,
  isActive: true,
};

function context(id = "svc_1") {
  return { params: Promise.resolve({ id }) };
}

function getRequest(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/services/svc_1", {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function patchRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/services/svc_1", {
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
  findServiceById.mockReset();
  updateService.mockReset();
  upsertServiceTranslation.mockReset();
  findServiceById.mockResolvedValue(SERVICE);
  updateService.mockResolvedValue(SERVICE);
  upsertServiceTranslation.mockResolvedValue({ id: "tr_1" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/services/[id]", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(getRequest(null), context())).status).toBe(401);
    expect((await GET(getRequest("customer"), context())).status).toBe(403);
    expect(findServiceById).not.toHaveBeenCalled();
  });

  it("returns the service and writes no audit row", async () => {
    const response = await GET(getRequest("staff"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: SERVICE });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 without echoing the requested id", async () => {
    findServiceById.mockResolvedValue(null);
    const response = await GET(getRequest("staff"), context("svc_probe_777"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "SERVICE_NOT_FOUND",
      message: safeMessageForCode("SERVICE_NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("svc_probe_777");
  });
});

describe("PATCH /api/services/[id]", () => {
  it("is closed to the staff role", async () => {
    expect((await PATCH(patchRequest({ priceCents: 1 }, null), context())).status).toBe(401);
    expect((await PATCH(patchRequest({ priceCents: 1 }, "staff"), context())).status).toBe(403);
    expect(updateService).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("writes exactly one audit row with the before and after snapshot", async () => {
    updateService.mockResolvedValue(SERVICE);
    findServiceById
      .mockResolvedValueOnce(SERVICE)
      .mockResolvedValueOnce({ ...SERVICE, priceCents: 5_000 });

    const response = await PATCH(patchRequest({ priceCents: 5_000 }), context());
    expect(response.status).toBe(200);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "service.update",
      entityType: "service",
      entityId: "svc_1",
    });
    expect(audits[0].before).toMatchObject({ priceCents: 4_500 });
    expect(audits[0].after).toMatchObject({ priceCents: 5_000 });
  });

  it("accepts the slug from the editor but never rewrites the public booking key", async () => {
    await PATCH(patchRequest({ slug: "cheap-cut", priceCents: 1_000 }), context());
    const [, input] = updateService.mock.calls[0];
    expect(input).not.toHaveProperty("slug");
    expect(input).toMatchObject({ priceCents: 1_000 });
  });

  it("writes each supplied translation and records the locales it touched", async () => {
    await PATCH(
      patchRequest({
        translations: [
          { locale: "de", name: "Damenschnitt", description: "" },
          { locale: "it", name: "Taglio donna", description: "" },
        ],
      }),
      context(),
    );
    expect(upsertServiceTranslation).toHaveBeenCalledTimes(2);
    expect(audits[0].after).toMatchObject({ locales: ["de", "it"] });
  });

  it("rejects an unknown field and an over-long translation", async () => {
    const unknown = await PATCH(patchRequest({ createdBy: "usr_2" }), context());
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("VALIDATION_ERROR");

    const longDescription = await PATCH(
      patchRequest({
        translations: [{ locale: "de", name: "x", description: "d".repeat(5_001) }],
      }),
      context(),
    );
    expect(longDescription.status).toBe(400);
    expect(updateService).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("returns 404 for an unknown service and audits nothing", async () => {
    findServiceById.mockResolvedValue(null);
    const response = await PATCH(patchRequest({ priceCents: 1 }), context());
    expect(response.status).toBe(404);
    expect(updateService).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("never leaks a database failure to the browser", async () => {
    updateService.mockRejectedValue(
      new Error(
        "Invalid `prisma.service.update()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await PATCH(patchRequest({ priceCents: 1 }), context());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(audits).toHaveLength(0);
  });
});
