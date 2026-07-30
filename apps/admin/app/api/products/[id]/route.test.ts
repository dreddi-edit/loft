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
} from "../../../../lib/admin-api";

const findProductById = vi.fn();
const updateProduct = vi.fn();
const deleteProduct = vi.fn();

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
    findProductById: (...args: unknown[]) => findProductById(...args),
    updateProduct: (...args: unknown[]) => updateProduct(...args),
    deleteProduct: (...args: unknown[]) => deleteProduct(...args),
  },
}));

const { GET, PATCH, DELETE } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const PRODUCT = { id: "prd_1", sku: "DAV-001", name: "Momo Shampoo", priceCents: 2_400, stock: 12 };

function context(id = "prd_1") {
  return { params: Promise.resolve({ id }) };
}

function build(method: string, role: string | null, body?: unknown): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/products/prd_1", {
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
  setAdminApiLogSink(() => {});
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  resetAdminRateLimits();
  requireSession.mockClear();
  findProductById.mockReset();
  updateProduct.mockReset();
  deleteProduct.mockReset();
  findProductById.mockResolvedValue(PRODUCT);
  updateProduct.mockResolvedValue({ ...PRODUCT, priceCents: 2_600 });
  deleteProduct.mockResolvedValue({ ...PRODUCT, deletedAt: "2026-07-29T10:00:00.000Z" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/products/[id]", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(build("GET", null), context())).status).toBe(401);
    expect((await GET(build("GET", "customer"), context())).status).toBe(403);
    expect(findProductById).not.toHaveBeenCalled();
  });

  it("returns the product and writes no audit row", async () => {
    const response = await GET(build("GET", "staff"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: PRODUCT });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 without echoing the requested id", async () => {
    findProductById.mockResolvedValue(null);
    const response = await GET(build("GET", "staff"), context("prd_probe_999"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prd_probe_999");
  });
});

describe("PATCH /api/products/[id]", () => {
  it("is closed to the staff role", async () => {
    expect((await PATCH(build("PATCH", null, { priceCents: 1 }), context())).status).toBe(401);
    expect((await PATCH(build("PATCH", "staff", { priceCents: 1 }), context())).status).toBe(403);
    expect(updateProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("writes exactly one audit row with the before and after snapshot", async () => {
    const response = await PATCH(build("PATCH", "manager", { priceCents: 2_600 }), context());
    expect(response.status).toBe(200);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "product.update",
      entityType: "product",
      entityId: "prd_1",
    });
    expect(audits[0].before).toMatchObject({ priceCents: 2_400 });
    expect(audits[0].after).toMatchObject({ priceCents: 2_600 });
  });

  it("refuses a direct stock write, which has to go through the inventory route", async () => {
    const response = await PATCH(build("PATCH", "manager", { stock: 9_000 }), context());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(updateProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("returns 404 for an unknown product and audits nothing", async () => {
    findProductById.mockResolvedValue(null);
    const response = await PATCH(build("PATCH", "manager", { priceCents: 1 }), context());
    expect(response.status).toBe(404);
    expect(updateProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe("DELETE /api/products/[id]", () => {
  it("is closed to the staff role", async () => {
    expect((await DELETE(build("DELETE", null), context())).status).toBe(401);
    expect((await DELETE(build("DELETE", "staff"), context())).status).toBe(403);
    expect(deleteProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("writes exactly one audit row recording what was removed", async () => {
    const response = await DELETE(build("DELETE", "owner"), context());
    expect(response.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "product.delete", entityId: "prd_1" });
    expect(audits[0].before).toMatchObject({ sku: "DAV-001", stock: 12 });
    expect(audits[0].after).toMatchObject({ deleted: true });
  });

  it("is bounded by the sensitive policy", async () => {
    const definition = ADMIN_RATE_LIMIT_POLICIES.adminSensitive;
    const ceiling = definition.limit + (definition.burst ?? 0);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await DELETE(build("DELETE", "owner"), context())).status).toBe(200);
    }
    const blocked = await DELETE(build("DELETE", "owner"), context());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(audits).toHaveLength(ceiling);
  });

  it("never leaks a foreign key constraint to the browser", async () => {
    deleteProduct.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.product.delete()` invocation in /app/packages/db/src/client.ts:33 " +
            "Foreign key constraint failed on the field: `InventoryMovement_productId_fkey`",
        ),
        { code: "P2003" },
      ),
    );

    const response = await DELETE(build("DELETE", "owner"), context());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("InventoryMovement_productId_fkey");
    expect(encoded).not.toContain("prisma");
    expect(audits).toHaveLength(0);
  });
});
