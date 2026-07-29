import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyBookingToken } = vi.hoisted(() => ({ verifyBookingToken: vi.fn() }));

vi.mock("@hair-simo/core", () => ({
  verifyBookingToken,
  VERIFICATION_INVALID: "BOOKING_VERIFICATION_INVALID",
  VERIFICATION_CANCELLED: "BOOKING_VERIFICATION_APPOINTMENT_CANCELLED",
}));

import { resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { GET, HEAD } from "./route";

const TOKEN = "Yx7QsD1kZ2mN4pR6tV8wA0bC3eF5gH7jK9lM1nO3pQ4";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  verifyBookingToken.mockReset();
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

function request(
  init: { method?: string; headers?: Record<string, string>; token?: string } = {},
): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/verify/${init.token ?? TOKEN}`, {
    method: init.method ?? "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN, ...init.headers },
  });
}

function context(token: string = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

async function statusOf(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { data?: { status?: string } };
  return body.data?.status;
}

describe("GET /api/verify/[token] redemption", () => {
  it("confirms a booking on the first click", async () => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: false });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await statusOf(response)).toBe("confirmed");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(verifyBookingToken).toHaveBeenCalledWith(TOKEN);
  });

  it("reports already_confirmed instead of failing on a second click", async () => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: true });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await statusOf(response)).toBe("already_confirmed");
  });

  it("collapses unknown, expired and superseded tokens into one status", async () => {
    verifyBookingToken.mockRejectedValue(new Error("BOOKING_VERIFICATION_INVALID"));

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await statusOf(response)).toBe("invalid");
  });

  it("reports a cancelled appointment separately", async () => {
    verifyBookingToken.mockRejectedValue(new Error("BOOKING_VERIFICATION_APPOINTMENT_CANCELLED"));

    expect(await statusOf(await GET(request(), context()))).toBe("cancelled");
  });

  it("rejects a malformed token without touching the service", async () => {
    const response = await GET(request({ token: "short" }), context("short"));

    expect(response.status).toBe(200);
    expect(await statusOf(response)).toBe("invalid");
    expect(verifyBookingToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/verify/[token] prefetch safety", () => {
  const prefetchHeaders: Record<string, string>[] = [
    { "sec-purpose": "prefetch;prerender" },
    { purpose: "prefetch" },
    { "x-purpose": "preview" },
    { "x-moz": "prefetch" },
  ];

  it.each(prefetchHeaders)("never redeems for %o", async (headers) => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: false });

    const response = await GET(request({ headers }), context());

    expect(response.status).toBe(200);
    expect(await statusOf(response)).toBe("pending");
    expect(verifyBookingToken).not.toHaveBeenCalled();
  });

  it("never redeems for a scanner following the link as a document", async () => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: false });

    const response = await GET(request({ headers: { "sec-fetch-dest": "document" } }), context());

    expect(await statusOf(response)).toBe("pending");
    expect(verifyBookingToken).not.toHaveBeenCalled();
  });

  it("redeems for the verify page's own fetch", async () => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: false });

    const response = await GET(
      request({ headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } }),
      context(),
    );

    expect(await statusOf(response)).toBe("confirmed");
    expect(verifyBookingToken).toHaveBeenCalledTimes(1);
  });

  it("redeems when the client sends no fetch metadata at all", async () => {
    verifyBookingToken.mockResolvedValue({ appointmentId: "apt_1", alreadyVerified: false });

    expect(await statusOf(await GET(request(), context()))).toBe("confirmed");
  });

  it("answers HEAD without burning the token", async () => {
    const response = await HEAD(request({ method: "HEAD" }), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(verifyBookingToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/verify/[token] failure modes", () => {
  it("refuses any method other than GET", async () => {
    const response = await GET(request({ method: "DELETE" }), context());

    expect(response.status).toBe(405);
    expect(verifyBookingToken).not.toHaveBeenCalled();
  });

  it("never leaks a raw error message when the service blows up", async () => {
    verifyBookingToken.mockRejectedValue(
      new Error("Connection terminated: postgres://simo:hunter2@10.0.0.4:5432/hairsimo"),
    );

    const response = await GET(request(), context());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.error).toBe("INTERNAL");
    expect(body.message).toBe("An unexpected error occurred. Please try again later.");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(logs.at(-1)?.severity).toBe("ERROR");
  });

  it("rate limits token guessing per client ip", async () => {
    verifyBookingToken.mockRejectedValue(new Error("BOOKING_VERIFICATION_INVALID"));
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.availability);

    for (let attempt = 0; attempt < ceiling; attempt += 1) {
      expect((await GET(request(), context())).status).toBe(200);
    }

    const blocked = await GET(request(), context());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(verifyBookingToken).toHaveBeenCalledTimes(ceiling);
  });
});
