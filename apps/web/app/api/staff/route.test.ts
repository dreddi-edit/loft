import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";

const listStaff = vi.fn();

vi.mock("@hair-simo/core", () => ({
  salonRepository: { listStaff: (...args: unknown[]) => listStaff(...args) },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function request(): NextRequest {
  return new NextRequest("https://hairsimo.it/api/staff", {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  listStaff.mockReset();
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("GET /api/staff", () => {
  it("exposes only bookable members and only their id and display name", async () => {
    listStaff.mockResolvedValue([
      {
        id: "staff_1",
        displayName: "Simo",
        email: "simo@hairsimo.it",
        phone: "+39 333 1234567",
        user: { passwordHash: "$2b$12$secret" },
      },
    ]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ data: [{ id: "staff_1", displayName: "Simo" }] });
    expect(listStaff).toHaveBeenCalledWith({ isBookable: true });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("passwordHash");
    expect(encoded).not.toContain("simo@hairsimo.it");
    expect(encoded).not.toContain("+39 333 1234567");
  });

  it("rejects a write method with 405", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/staff", { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
    expect(listStaff).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the publicRead policy is exceeded", async () => {
    listStaff.mockResolvedValue([]);
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
    listStaff.mockRejectedValue(new Error("connect ECONNREFUSED 10.8.0.3:5432 at /app/node_modules"));

    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("node_modules");
  });
});
