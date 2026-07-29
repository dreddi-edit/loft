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
} from "../../../../../lib/admin-api";

const findProductById = vi.fn();
const adjustProductStock = vi.fn();
const movementFindMany = vi.fn();

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
    findProductById: (...args: unknown[]) => findProductById(...args),
    adjustProductStock: (...args: unknown[]) => adjustProductStock(...args),
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
  prisma: { inventoryMovement: { findMany: (...args: unknown[]) => movementFindMany(...args) } },
}));

const { GET, POST, inventoryAdjustmentSchema } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const PRODUCT = { id: "prd_1", sku: "DAV-001", name: "Momo", priceCents: 2_400, stock: 12 };

function context(id = "prd_1") {
  return { params: Promise.resolve({ id }) };
}

function getRequest(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/products/prd_1/inventory${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function postRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/products/prd_1/inventory", {
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
  findProductById.mockReset();
  adjustProductStock.mockReset();
  movementFindMany.mockReset();
  findProductById.mockResolvedValue(PRODUCT);
  adjustProductStock.mockResolvedValue({
    product: { ...PRODUCT, stock: 10 },
    movement: { id: "mov_1", delta: -2, type: "sale", reason: "Retail sale" },
  });
  movementFindMany.mockResolvedValue([{ id: "mov_1", delta: -2 }]);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("admin API mutation validation", () => {
  it("accepts traceable inventory adjustments", () => {
    expect(
      inventoryAdjustmentSchema.parse({ quantity: -2, type: "sale", reason: "Retail sale" }),
    ).toEqual({ quantity: -2, type: "sale", reason: "Retail sale" });
  });

  it("rejects zero-value and mass-assignment inventory changes", () => {
    expect(() =>
      inventoryAdjustmentSchema.parse({ quantity: 0, stock: 900, type: "adjustment" }),
    ).toThrow();
  });
});

describe("GET /api/products/[id]/inventory", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(getRequest(null), context())).status).toBe(401);
    expect((await GET(getRequest("customer"), context())).status).toBe(403);
    expect(movementFindMany).not.toHaveBeenCalled();
  });

  it("pages the stock history and writes no audit row", async () => {
    const response = await GET(getRequest("staff", "?limit=10&offset=20"), context());
    expect(response.status).toBe(200);
    expect(movementFindMany).toHaveBeenCalledWith({
      where: { productId: "prd_1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 20,
      take: 10,
    });
    expect(audits).toHaveLength(0);
  });

  it("refuses a page size outside the allowed range", async () => {
    const response = await GET(getRequest("staff", "?limit=0"), context());
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("limit");
    expect(movementFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/products/[id]/inventory", () => {
  it("is closed to the staff role", async () => {
    expect((await POST(postRequest({ quantity: -1 }, null), context())).status).toBe(401);
    expect((await POST(postRequest({ quantity: -1 }, "staff"), context())).status).toBe(403);
    expect(adjustProductStock).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("adjusts the product named in the path and audits exactly once", async () => {
    const response = await POST(
      postRequest({ quantity: -2, type: "sale", reason: "Retail sale" }),
      context("prd_1"),
    );
    expect(response.status).toBe(201);
    expect(adjustProductStock).toHaveBeenCalledExactlyOnceWith("prd_1", {
      quantity: -2,
      type: "sale",
      reason: "Retail sale",
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "product.inventoryAdjustment",
      entityType: "product",
      entityId: "prd_1",
    });
    expect(audits[0].before).toMatchObject({ stock: 12 });
    expect(audits[0].after).toMatchObject({ stock: 10, delta: -2 });
  });

  it("refuses a movement of zero and an unknown movement type", async () => {
    const zero = await POST(postRequest({ quantity: 0 }), context());
    expect(zero.status).toBe(400);
    expect((await zero.json()).details[0].path).toBe("quantity");

    const type = await POST(postRequest({ quantity: 1, type: "shrinkage" }), context());
    expect(type.status).toBe(400);
    expect((await type.json()).details[0].path).toBe("type");
    expect(adjustProductStock).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("returns 404 for an unknown product and audits nothing", async () => {
    findProductById.mockResolvedValue(null);
    const response = await POST(postRequest({ quantity: -1 }), context("prd_missing"));
    expect(response.status).toBe(404);
    expect(adjustProductStock).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("maps an oversold adjustment onto the taxonomy", async () => {
    adjustProductStock.mockRejectedValue(new Error("INSUFFICIENT_STOCK:12 available, 40 asked"));
    const response = await POST(postRequest({ quantity: -40 }), context());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toBe("INSUFFICIENT_STOCK");
    expect(body.message).toBe(safeMessageForCode("INSUFFICIENT_STOCK"));
    expect(JSON.stringify(body)).not.toContain("40 asked");
    expect(audits).toHaveLength(0);
  });

  it("never leaks a database failure to the browser", async () => {
    adjustProductStock.mockRejectedValue(
      new Error(
        "Invalid `prisma.$transaction()` invocation in /app/packages/core/src/repositories.ts:912",
      ),
    );
    const response = await POST(postRequest({ quantity: -1 }), context());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(JSON.stringify(body)).not.toContain("/app/packages");
    expect(audits).toHaveLength(0);
  });
});
