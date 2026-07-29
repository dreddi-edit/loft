import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { staffFindUnique, appointmentFindMany } = vi.hoisted(() => ({
  staffFindUnique: vi.fn(),
  appointmentFindMany: vi.fn(),
}));

vi.mock("@hair-simo/db", () => ({
  prisma: {
    staffProfile: { findUnique: staffFindUnique },
    appointment: { findMany: appointmentFindMany },
  },
}));

import { createStaffFeedToken } from "@hair-simo/core";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { GET } from "./route";

const FEED_SECRET = "1b6c8f2a4e7d9c0b3a5f8e1d4c7b0a9f2e5d8c1b4a7f0e3d6c9b2a5f8e1d4c7b";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const STAFF_ID = "staff1";
const OTHER_STAFF_ID = "staff2";
const MS_PER_DAY = 86_400_000;

const appointmentRow = {
  id: "appt1",
  startsAt: new Date("2026-08-04T06:00:00.000Z"),
  endsAt: new Date("2026-08-04T07:15:00.000Z"),
  locale: "de",
  status: "confirmed",
  notes: "Kundin zahlt immer bar",
  cancellationReason: null,
  createdAt: new Date("2026-07-20T09:00:00.000Z"),
  updatedAt: new Date("2026-07-21T10:30:00.000Z"),
  service: { slug: "cut", translations: [{ locale: "de", name: "Haarschnitt" }] },
  staff: { displayName: "Simona" },
  customer: {
    firstName: "Anna",
    lastName: "Müller",
    email: "anna@example.com",
    deletedAt: null,
    anonymizedAt: null,
  },
};

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  vi.stubEnv("STAFF_FEED_TOKEN_SECRET", FEED_SECRET);
  staffFindUnique.mockResolvedValue({
    id: STAFF_ID,
    displayName: "Simona",
    locale: "de",
    user: { active: true },
  });
  appointmentFindMany.mockResolvedValue([appointmentRow]);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function call(token: string, headers: Record<string, string> = {}): Promise<Response> {
  const request = new NextRequest(`https://hairsimo.it/api/calendar/${token}`, {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN, ...headers },
  });
  return GET(request, { params: Promise.resolve({ token }) });
}

function tamper(token: string): string {
  const last = token.slice(-1);
  return `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

async function bodyWithoutRequestId(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  delete body.requestId;
  return body;
}

describe("GET /api/calendar/[token] success", () => {
  it("returns raw iCalendar with a filename instead of the JSON envelope", async () => {
    const response = await call(createStaffFeedToken(STAFF_ID));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="hair-simo-${STAFF_ID}.ics"`,
    );
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(() => JSON.parse(body)).toThrow();
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts the .ics suffix calendar clients append", async () => {
    const response = await call(`${createStaffFeedToken(STAFF_ID)}.ics`);
    expect(response.status).toBe(200);
    expect((await response.text()).startsWith("BEGIN:VCALENDAR")).toBe(true);
  });

  it("bounds the window and the event count it will ever serve", async () => {
    await call(createStaffFeedToken(STAFF_ID));

    const args = appointmentFindMany.mock.calls[0]?.[0] as {
      where: { staffId: string; startsAt: { gte: Date; lt: Date } };
      take: number;
    };
    const now = Date.now();
    expect(args.where.staffId).toBe(STAFF_ID);
    expect(args.take).toBeLessThanOrEqual(1_000);
    expect(now - args.where.startsAt.gte.getTime()).toBeLessThanOrEqual(31 * MS_PER_DAY);
    expect(args.where.startsAt.lt.getTime() - now).toBeLessThanOrEqual(181 * MS_PER_DAY);
    expect(args.where.startsAt.lt.getTime()).toBeGreaterThan(args.where.startsAt.gte.getTime());
  });
});

describe("GET /api/calendar/[token] auth boundary", () => {
  it("answers a tampered token and an unknown staff member identically", async () => {
    const tampered = await call(tamper(createStaffFeedToken(STAFF_ID)));

    staffFindUnique.mockResolvedValue(null);
    const unknown = await call(createStaffFeedToken(STAFF_ID));

    expect(tampered.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await bodyWithoutRequestId(tampered)).toEqual(await bodyWithoutRequestId(unknown));
  });

  it("never answers with 401, which a calendar subscription cannot act on", async () => {
    const response = await call("not-a-token");
    expect(response.status).toBe(404);
    expect(await bodyWithoutRequestId(response)).toEqual({
      error: "NOT_FOUND",
      message: "This calendar feed does not exist.",
    });
  });

  it("stops serving a deactivated staff member", async () => {
    staffFindUnique.mockResolvedValue({
      id: STAFF_ID,
      displayName: "Simona",
      locale: "de",
      user: { active: false },
    });
    const response = await call(createStaffFeedToken(STAFF_ID));
    expect(response.status).toBe(404);
    expect(appointmentFindMany).not.toHaveBeenCalled();
  });

  it("rejects an oversized path segment before doing any crypto or database work", async () => {
    const response = await call("v1.staff1.".concat("A".repeat(400)));
    expect(response.status).toBe(404);
    expect(staffFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a method outside the allowlist", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    const request = new NextRequest(`https://hairsimo.it/api/calendar/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
    });
    const response = await GET(request, { params: Promise.resolve({ token }) });
    expect(response.status).toBe(405);
  });

  it("reports a missing server secret as a server error, not as a missing feed", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    vi.stubEnv("STAFF_FEED_TOKEN_SECRET", undefined);
    vi.stubEnv("JWT_SECRET", undefined);

    const response = await call(token);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("INTERNAL");
  });

  it("never returns a raw failure to the subscriber", async () => {
    const leak =
      "Invalid `prisma.staffProfile.findUnique()` invocation in /app/packages/db/src/client.ts:12";
    staffFindUnique.mockRejectedValue(new Error(leak));

    const response = await call(createStaffFeedToken(STAFF_ID));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain(safeMessageForCode("INTERNAL"));
    expect(body).not.toContain("prisma");
    expect(String(logs.at(-1)?.error)).toContain("prisma.staffProfile.findUnique");
  });
});

describe("GET /api/calendar/[token] conditional requests", () => {
  it("returns 304 for a matching If-None-Match and keeps the validators", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    const first = await call(token);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

    const second = await call(token, { "if-none-match": etag ?? "" });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toContain("max-age=300");
    expect(await second.text()).toBe("");
  });

  it("keeps the validator stable while only the serialisation clock moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-25T08:00:00.000Z"));
    const token = createStaffFeedToken(STAFF_ID);
    const first = await call(token);
    const firstBody = await first.text();

    vi.setSystemTime(new Date("2026-07-25T09:00:00.000Z"));
    const second = await call(token);
    const secondBody = await second.text();

    expect(secondBody).not.toBe(firstBody);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  });

  it("changes the validator when an appointment changes", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    const first = await call(token);

    appointmentFindMany.mockResolvedValue([
      { ...appointmentRow, updatedAt: new Date("2026-07-22T11:00:00.000Z") },
    ]);
    const second = await call(token);

    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  });

  it("honours If-Modified-Since when the client sends no entity tag", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    const first = await call(token);
    const lastModified = first.headers.get("last-modified");
    expect(lastModified).toBe(new Date("2026-07-21T10:30:00.000Z").toUTCString());

    const fresh = await call(token, { "if-modified-since": lastModified ?? "" });
    expect(fresh.status).toBe(304);

    const stale = await call(token, {
      "if-modified-since": new Date("2026-07-20T00:00:00.000Z").toUTCString(),
    });
    expect(stale.status).toBe(200);
  });

  it("ignores If-Modified-Since when an entity tag is present, as RFC 9110 requires", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    const response = await call(token, {
      "if-none-match": '"stale"',
      "if-modified-since": new Date("2027-01-01T00:00:00.000Z").toUTCString(),
    });
    expect(response.status).toBe(200);
  });
});

describe("GET /api/calendar/[token] rate limiting", () => {
  const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.publicRead);

  it("meters each feed separately so one busy subscription cannot starve another", async () => {
    const token = createStaffFeedToken(STAFF_ID);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await call(token)).status).toBe(200);
    }
    expect((await call(token)).status).toBe(429);

    staffFindUnique.mockResolvedValue({
      id: OTHER_STAFF_ID,
      displayName: "Marco",
      locale: "it",
      user: { active: true },
    });
    expect((await call(createStaffFeedToken(OTHER_STAFF_ID))).status).toBe(200);
  });

  it("meters unverifiable tokens by caller ip so the token space cannot be walked", async () => {
    for (let index = 0; index < ceiling; index += 1) {
      expect((await call(`v1.staff1.guess${index}`)).status).toBe(404);
    }
    expect((await call("v1.staff1.guessLast")).status).toBe(429);
    expect((await call(createStaffFeedToken(STAFF_ID))).status).toBe(200);
  });
});
