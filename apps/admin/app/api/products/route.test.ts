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

const listProducts = vi.fn();
const createProduct = vi.fn();
const findProductById = vi.fn();

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
    listProducts: (...args: unknown[]) => listProducts(...args),
    createProduct: (...args: unknown[]) => createProduct(...args),
    findProductById: (...args: unknown[]) => findProductById(...args),
  },
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const PRODUCT = { id: "prd_1", sku: "DAV-001", name: "Momo Shampoo", priceCents: 2_400, stock: 12 };
const VALID_CREATE = { sku: "DAV-001", name: "Momo Shampoo", priceCents: 2_400 };

function listRequest(role: string | null = "staff", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/products${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function createRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/products", {
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
  listProducts.mockReset();
  createProduct.mockReset();
  findProductById.mockReset();
  listProducts.mockResolvedValue([PRODUCT]);
  createProduct.mockResolvedValue(PRODUCT);
  findProductById.mockResolvedValue(PRODUCT);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/products", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(listRequest(null))).status).toBe(401);
    expect((await GET(listRequest("customer"))).status).toBe(403);
    expect(listProducts).not.toHaveBeenCalled();
  });

  it("returns a page envelope and writes no audit row", async () => {
    const response = await GET(listRequest("staff", "?limit=20&lowStockAt=5"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pagination: { limit: 20, offset: 0 } });
    expect(listProducts).toHaveBeenCalledWith({
      query: undefined,
      lowStockAt: 5,
      skip: 0,
      take: 20,
    });
    expect(audits).toHaveLength(0);
  });

  it("rejects an out-of-range threshold and an unknown parameter", async () => {
    const threshold = await GET(listRequest("staff", "?lowStockAt=-1"));
    expect(threshold.status).toBe(400);
    expect((await threshold.json()).details[0].path).toBe("lowStockAt");

    const unknown = await GET(listRequest("staff", "?orderBy=priceCents"));
    expect(unknown.status).toBe(400);
    expect(listProducts).not.toHaveBeenCalled();
  });
});

describe("POST /api/products", () => {
  it("is closed to the staff role", async () => {
    expect((await POST(createRequest(VALID_CREATE, null))).status).toBe(401);
    const staff = await POST(createRequest(VALID_CREATE, "staff"));
    expect(staff.status).toBe(403);
    expect(createProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("creates the product and writes exactly one audit row", async () => {
    const response = await POST(createRequest(VALID_CREATE));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: PRODUCT });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "product.create",
      entityType: "product",
      entityId: "prd_1",
      actorId: "usr_1",
    });
    expect(audits[0].after).toMatchObject({ sku: "DAV-001", priceCents: 2_400 });
  });

  it("refuses a negative price and an unknown field", async () => {
    const price = await POST(createRequest({ ...VALID_CREATE, priceCents: -1 }));
    expect(price.status).toBe(400);
    expect((await price.json()).details[0].path).toBe("priceCents");

    const unknown = await POST(createRequest({ ...VALID_CREATE, id: "prd_hijack" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("VALIDATION_ERROR");
    expect(createProduct).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("bounds the sku and the name", async () => {
    const response = await POST(
      createRequest({ sku: "s".repeat(101), name: "n".repeat(201), priceCents: 100 }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path).sort(),
    ).toEqual(["name", "sku"]);
  });

  it("never leaks a unique constraint name to the browser", async () => {
    createProduct.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid `prisma.product.create()` invocation in /app/packages/db/src/client.ts:33 " +
            "Unique constraint failed on the fields: (`sku`)",
        ),
        { code: "P2002", meta: { target: ["Product_sku_key"] } },
      ),
    );

    const response = await POST(createRequest(VALID_CREATE));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("Product_sku_key");
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("/app/packages");
    expect(audits).toHaveLength(0);
  });
});
