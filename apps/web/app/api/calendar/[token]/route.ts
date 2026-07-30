import { createHash } from "node:crypto";
import {
  buildStaffFeedForToken,
  endOfSalonDay,
  startOfSalonDay,
  verifyStaffFeedToken,
  type StaffFeedResult,
} from "@hair-simo/core";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute, type RateLimitKeyContext } from "../../../../lib/api-handler";

type TokenParams = { token: string };

const MS_PER_DAY = 86_400_000;
const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 180;
const FEED_EVENT_LIMIT = 1_000;
const FEED_REFRESH_MINUTES = 60;
const FEED_CACHE_SECONDS = 300;
const MAX_TOKEN_LENGTH = 256;

/**
 * Both are a dead end for the caller and must stay indistinguishable: a tampered signature
 * and a staff member who no longer exists produce the same 404 with the same body.
 */
const FEED_REJECTIONS: ReadonlySet<string> = new Set([
  "STAFF_FEED_TOKEN_INVALID",
  "STAFF_FEED_NOT_FOUND",
]);

const DTSTAMP_LINE = /^DTSTAMP:.*\r?\n/gm;
const LAST_MODIFIED_LINE = /^LAST-MODIFIED:(\d{8})T(\d{6})Z\r?$/gm;

function normalizeToken(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(".ics") ? trimmed.slice(0, -4) : trimmed;
}

function feedNotFound(cause: unknown): HttpError {
  return new HttpError("NOT_FOUND", {
    message: "This calendar feed does not exist.",
    cause,
    logMessage: "staff calendar feed rejected",
  });
}

function tokenFromPath(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  try {
    return normalizeToken(decodeURIComponent(last));
  } catch {
    return normalizeToken(last);
  }
}

/**
 * Calendar clients poll from shared infrastructure — every Google Calendar subscription in
 * the world leaves the same handful of Google IPs — so an IP bucket would let one salon
 * feed exhaust the allowance of every other. A token that verifies is therefore billed to
 * its staff member; anything that does not verify falls back to the caller's IP, which is
 * what bounds someone walking the token space.
 */
function feedRateLimitKey({ req, clientIp }: RateLimitKeyContext): string {
  const token = tokenFromPath(req.nextUrl.pathname);
  if (token.length > 0 && token.length <= MAX_TOKEN_LENGTH) {
    try {
      return `staff:${verifyStaffFeedToken(token).staffId}`;
    } catch {
      // Unverifiable, including a missing server secret: bill the IP instead.
    }
  }
  return `ip:${clientIp.key}`;
}

async function loadFeed(token: string, now: Date): Promise<StaffFeedResult> {
  const from = startOfSalonDay(new Date(now.getTime() - FEED_PAST_DAYS * MS_PER_DAY));
  const to = endOfSalonDay(new Date(now.getTime() + FEED_FUTURE_DAYS * MS_PER_DAY));
  try {
    return await buildStaffFeedForToken(token, {
      now,
      refreshIntervalMinutes: FEED_REFRESH_MINUTES,
      range: { from, to, limit: FEED_EVENT_LIMIT },
    });
  } catch (error) {
    if (error instanceof Error && FEED_REJECTIONS.has(error.message)) throw feedNotFound(error);
    throw error;
  }
}

/**
 * DTSTAMP is the wall-clock moment the document was serialised, so it moves on every
 * request even when nothing changed. Hashing the calendar with those lines removed makes
 * the validator track the appointments instead of the clock, which is the whole point of
 * answering a poll with a 304.
 */
function feedEtag(calendar: string): string {
  const stable = calendar.replace(DTSTAMP_LINE, "");
  return `"${createHash("sha256").update(stable).digest("base64url")}"`;
}

/** Newest LAST-MODIFIED in the document, i.e. the newest `updatedAt` in the window. */
function feedLastModified(calendar: string): Date | null {
  let newest = 0;
  for (const [, day, time] of calendar.matchAll(LAST_MODIFIED_LINE)) {
    const iso =
      `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T` +
      `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest > 0 ? new Date(newest) : null;
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}

function notModifiedSince(header: string | null, lastModified: Date | null): boolean {
  if (!header || !lastModified) return false;
  const since = Date.parse(header);
  if (!Number.isFinite(since)) return false;
  // HTTP dates carry no sub-second part, so compare at second resolution.
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
}

function validatorHeaders(etag: string, lastModified: Date | null): Record<string, string> {
  return {
    etag,
    "cache-control": `private, max-age=${FEED_CACHE_SECONDS}, must-revalidate`,
    ...(lastModified ? { "last-modified": lastModified.toUTCString() } : {}),
  };
}

/**
 * The subscribable per-staff feed. Unlike every other route in this app the body is raw
 * iCalendar, not the `{ data }` envelope: Google Calendar, Apple Calendar and Outlook read
 * the response verbatim. `apiRoute` passes a `Response` through untouched and only stamps
 * the request id and the rate limit headers on it, so the wrapper still owns the method
 * guard, the limiter and the error taxonomy while the success path stays text/calendar.
 *
 * A subscription cannot answer an auth challenge, so the unguessable token in the path is
 * the credential and every failure is a 404.
 */
export const GET = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/calendar/[token]",
    methods: ["GET", "HEAD"],
    policy: "publicRead",
    rateLimitKey: feedRateLimitKey,
  },
  async ({ params, req, log }) => {
    const token = normalizeToken(params.token);
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw feedNotFound(new Error("STAFF_FEED_TOKEN_INVALID"));
    }

    const feed = await loadFeed(token, new Date());
    const etag = feedEtag(feed.calendar);
    const lastModified = feedLastModified(feed.calendar);
    const validators = validatorHeaders(etag, lastModified);

    const ifNoneMatch = req.headers.get("if-none-match");
    const fresh = ifNoneMatch
      ? matchesEtag(ifNoneMatch, etag)
      : notModifiedSince(req.headers.get("if-modified-since"), lastModified);

    if (fresh) {
      log.info("staff calendar feed not modified", { staffId: feed.staffId });
      return new Response(null, { status: 304, headers: validators });
    }

    log.info("staff calendar feed served", {
      staffId: feed.staffId,
      eventCount: feed.eventCount,
      bytes: feed.calendar.length,
    });

    return new Response(feed.calendar, {
      status: 200,
      headers: {
        ...validators,
        "content-type": feed.contentType,
        "content-disposition": `inline; filename="${feed.filename}"`,
      },
    });
  },
);
