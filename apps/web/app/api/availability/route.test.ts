import { NextRequest } from "next/server";
import { salonDayKey } from "@hair-simo/core/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";

const getAvailability = vi.fn();

vi.mock("@hair-simo/core", async () => {
  const time = await vi.importActual<typeof import("@hair-simo/core/time")>("@hair-simo/core/time");
  return {
    ...time,
    resolveTenantContext: async () => ({
      tenantId: "cltenant00000000000000001",
      slug: "hairsimo-brixen",
      displayName: "Hair Simo",
      timeZone: "Europe/Rome",
      defaultLocale: "it",
    }),
    BookingService: class {
      getAvailability = getAvailability;
    },
  };
});

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const MS_PER_DAY = 86_400_000;

function dayKeyOffsetBy(days: number): string {
  return salonDayKey(new Date(Date.now() + days * MS_PER_DAY));
}

function request(query: string): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/availability?${query}`, {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  getAvailability.mockReset();
  getAvailability.mockResolvedValue([]);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("GET /api/availability", () => {
  it("passes a validated query through to the booking service", async () => {
    getAvailability.mockResolvedValue([{ startsAt: "2026-08-01T08:00:00.000Z" }]);
    const day = dayKeyOffsetBy(1);

    const response = await GET(request(`serviceSlug=damen-schnitt&day=${day}&staffId=staff_1`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ startsAt: "2026-08-01T08:00:00.000Z" }] });
    expect(getAvailability).toHaveBeenCalledWith("damen-schnitt", day, "staff_1");
  });

  it("returns 400 with field-level detail for a missing or malformed query", async () => {
    const missing = await GET(request("day=2026-08-01"));
    expect(missing.status).toBe(400);
    const missingBody = await missing.json();
    expect(missingBody.error).toBe("VALIDATION_ERROR");
    expect(missingBody.details.map((detail: { path: string }) => detail.path)).toEqual([
      "serviceSlug",
    ]);

    const malformed = await GET(request("serviceSlug=cut&day=whenever"));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).details[0].path).toBe("day");
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it("bounds every free-text field so a query cannot be used as an amplifier", async () => {
    const long = "x".repeat(101);
    const slug = await GET(request(`serviceSlug=${long}&day=${dayKeyOffsetBy(1)}`));
    expect(slug.status).toBe(400);
    expect((await slug.json()).details[0].path).toBe("serviceSlug");

    const staff = await GET(
      request(`serviceSlug=cut&day=${dayKeyOffsetBy(1)}&staffId=${"y".repeat(65)}`),
    );
    expect(staff.status).toBe(400);
    expect((await staff.json()).details[0].path).toBe("staffId");
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it("refuses a day in the past and a day beyond the booking horizon", async () => {
    const past = await GET(request(`serviceSlug=cut&day=${dayKeyOffsetBy(-1)}`));
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({
      error: "VALIDATION_ERROR",
      message: "The requested day is in the past.",
    });

    const tooFar = await GET(request(`serviceSlug=cut&day=${dayKeyOffsetBy(400)}`));
    expect(tooFar.status).toBe(400);
    expect((await tooFar.json()).error).toBe("VALIDATION_ERROR");
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it("accepts today, which is the boundary of the past-day check", async () => {
    expect((await GET(request(`serviceSlug=cut&day=${dayKeyOffsetBy(0)}`))).status).toBe(200);
  });

  it("rejects a write method with 405", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/availability", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the availability policy is exceeded", async () => {
    const query = `serviceSlug=cut&day=${dayKeyOffsetBy(1)}`;
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.availability);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await GET(request(query))).status).toBe(200);
    }
    const blocked = await GET(request(query));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("maps a core domain error onto the taxonomy instead of leaking it", async () => {
    getAvailability.mockRejectedValue(new Error("SERVICE_NOT_FOUND"));
    const response = await GET(request(`serviceSlug=ghost&day=${dayKeyOffsetBy(1)}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "SERVICE_NOT_FOUND",
      message: safeMessageForCode("SERVICE_NOT_FOUND"),
    });
  });

  it("never leaks an unmapped failure to the client", async () => {
    getAvailability.mockRejectedValue(
      new Error(
        "Invalid `prisma.staffAvailability.findMany()` invocation in " +
          "/app/packages/core/src/availability-engine.ts:88",
      ),
    );

    const response = await GET(request(`serviceSlug=cut&day=${dayKeyOffsetBy(1)}`));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("/app/packages");
  });
});
