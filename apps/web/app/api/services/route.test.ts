import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";

const listServices = vi.fn();

vi.mock("@hair-simo/core", () => ({
  salonRepository: { listServices: (...args: unknown[]) => listServices(...args) },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/services", {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN, ...headers },
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  listServices.mockReset();
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("GET /api/services", () => {
  it("returns only the public projection of every service", async () => {
    listServices.mockResolvedValue([
      {
        id: "svc_1",
        slug: "damen-schnitt",
        category: "cut",
        durationMin: 45,
        priceCents: 4_500,
        translations: [{ locale: "de", name: "Damenschnitt", description: "" }],
        internalCostCents: 900,
        supplierNote: "never expose this",
      },
    ]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      "category",
      "durationMin",
      "id",
      "priceCents",
      "slug",
      "translations",
    ]);
    expect(JSON.stringify(body)).not.toContain("never expose this");
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a write method with 405", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/services", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
    expect(listServices).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the publicRead policy is exceeded", async () => {
    listServices.mockResolvedValue([]);
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.publicRead);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await GET(request())).status).toBe(200);
    }
    const blocked = await GET(request());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("never leaks a repository failure to the client", async () => {
    listServices.mockRejectedValue(
      new Error(
        "Invalid `prisma.service.findMany()` invocation in /app/packages/db/src/index.ts:41 " +
          "Unique constraint failed on the fields: (`slug`)",
      ),
    );

    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("packages/db");
    expect(encoded).not.toContain("Unique constraint");
  });
});
