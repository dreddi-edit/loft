import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import { resetRateLimitStore } from "../../../../lib/rate-limit";

const { recordClick } = vi.hoisted(() => ({ recordClick: vi.fn() }));

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  ReviewRequestService: class {
    recordClick = recordClick;
  },
}));

const { GET } = await import("./route");

const TOKEN = "Yx7QsD1kZ2mN4pR6tV8wA0bC3eF5gH7jK9lM1nO3pQ4";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const REDIRECT = "https://g.page/r/hair-simo/review";

function request(token: string = TOKEN): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/review/${token}`, {
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

function context(token: string = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  recordClick.mockReset();
  recordClick.mockResolvedValue({
    requestId: "rr_1",
    appointmentId: "apt_1",
    firstClick: true,
    redirectUrl: REDIRECT,
  });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
});

describe("GET /api/review/[token]", () => {
  it("records the click and redirects to the Google review URL", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(REDIRECT);
    expect(recordClick).toHaveBeenCalledWith(TOKEN);
  });

  it("still redirects on a repeat click without treating it as an error", async () => {
    recordClick.mockResolvedValue({
      requestId: "rr_1",
      appointmentId: "apt_1",
      firstClick: false,
      redirectUrl: REDIRECT,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(REDIRECT);
  });

  it("returns 404 with a safe message for an invalid or expired token", async () => {
    recordClick.mockRejectedValue(new Error("INVALID_REVIEW_TOKEN"));

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBe("This review link is invalid or has expired.");
    expect(body.message).not.toBe(safeMessageForCode("NOT_FOUND"));
  });

  it("returns 404 when the review request no longer exists", async () => {
    recordClick.mockRejectedValue(new Error("REVIEW_REQUEST_NOT_FOUND"));

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect((await response.json()).message).toBe("This review request no longer exists.");
  });
});
