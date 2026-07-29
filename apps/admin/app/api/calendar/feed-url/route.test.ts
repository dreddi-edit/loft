import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { staffFindUnique, sessionRef } = vi.hoisted(() => ({
  staffFindUnique: vi.fn(),
  sessionRef: { current: null as AuthSession | null },
}));

vi.mock("@hair-simo/db", () => ({
  prisma: { staffProfile: { findUnique: staffFindUnique } },
}));

vi.mock("../../../../lib/auth", () => ({
  requireSession: async (_request: NextRequest, allowed: RoleKey[]) => {
    const session = sessionRef.current;
    if (!session) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(session.role)) throw new Error("FORBIDDEN");
    return session;
  },
}));

import { verifyStaffFeedToken } from "@hair-simo/core";
import {
  ADMIN_RATE_LIMIT_POLICIES,
  resetAdminApiLogSink,
  resetAdminRateLimits,
  setAdminApiLogSink,
} from "../../../../lib/admin-api";
import { GET } from "./route";

const FEED_SECRET = "5c8e1b4d7f0a3c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e";
const BASE_URL = "https://hairsimo.it";
const OWN_STAFF_ID = "staffself";
const OTHER_STAFF_ID = "staffother";

function sessionFor(role: RoleKey, userId = "user-self"): AuthSession {
  return { userId, email: `${role}@hairsimo.it`, role, firstName: "Test", lastName: "User" };
}

type StaffWhere = { where: { id?: string; userId?: string } };

const staffRows: Record<string, { id: string; displayName: string; active: boolean }> = {
  [OWN_STAFF_ID]: { id: OWN_STAFF_ID, displayName: "Simona", active: true },
  [OTHER_STAFF_ID]: { id: OTHER_STAFF_ID, displayName: "Marco", active: true },
};

const profileByUser: Record<string, string> = { "user-self": OWN_STAFF_ID };

beforeEach(() => {
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  vi.stubEnv("STAFF_FEED_TOKEN_SECRET", FEED_SECRET);
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", BASE_URL);
  sessionRef.current = sessionFor("owner");
  staffFindUnique.mockImplementation(async (args: StaffWhere) => {
    if (args.where.userId) {
      const id = profileByUser[args.where.userId];
      return id ? { id } : null;
    }
    const row = args.where.id ? staffRows[args.where.id] : undefined;
    return row ? { id: row.id, displayName: row.displayName, user: { active: row.active } } : null;
  });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminRateLimits();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function call(query = ""): Promise<Response> {
  const request = new NextRequest(`https://admin.hairsimo.it/api/calendar/feed-url${query}`, {
    method: "GET",
    headers: { "x-forwarded-for": "203.0.113.7, 35.191.10.1" },
  });
  return GET(request);
}

async function json(response: Response): Promise<Record<string, never>> {
  return (await response.json()) as Record<string, never>;
}

describe("GET /api/calendar/feed-url", () => {
  it("returns a subscribable url whose token resolves to the requested staff member", async () => {
    const response = await call(`?staffId=${OTHER_STAFF_ID}`);
    const body = await json(response);
    const data = body.data as unknown as {
      staffId: string;
      displayName: string;
      feedUrl: string;
      webcalUrl: string;
    };

    expect(response.status).toBe(200);
    expect(data.staffId).toBe(OTHER_STAFF_ID);
    expect(data.displayName).toBe("Marco");
    expect(data.feedUrl.startsWith(`${BASE_URL}/api/calendar/`)).toBe(true);
    expect(data.feedUrl.endsWith(".ics")).toBe(true);
    expect(data.webcalUrl).toBe(data.feedUrl.replace("https:", "webcal:"));

    const token = data.feedUrl.slice(`${BASE_URL}/api/calendar/`.length, -".ics".length);
    expect(verifyStaffFeedToken(token)).toEqual({ staffId: OTHER_STAFF_ID });
  });

  it("falls back to the caller's own profile when no staff id is given", async () => {
    const body = await json(await call());
    expect((body.data as unknown as { staffId: string }).staffId).toBe(OWN_STAFF_ID);
  });
});

describe("GET /api/calendar/feed-url authorisation", () => {
  it("never hands a staff session another stylist's subscription token", async () => {
    sessionRef.current = sessionFor("staff");
    const response = await call(`?staffId=${OTHER_STAFF_ID}`);
    const raw = JSON.stringify(await json(response));

    expect(response.status).toBe(403);
    expect(raw).not.toContain("v1.");
    expect(raw).not.toContain(OTHER_STAFF_ID);
    expect(raw).not.toContain("/api/calendar/");
  });

  it("lets a staff session see its own feed, with or without the explicit id", async () => {
    sessionRef.current = sessionFor("staff");
    const implicit = await json(await call());
    const explicit = await json(await call(`?staffId=${OWN_STAFF_ID}`));

    expect((implicit.data as unknown as { staffId: string }).staffId).toBe(OWN_STAFF_ID);
    expect((explicit.data as unknown as { staffId: string }).staffId).toBe(OWN_STAFF_ID);
  });

  it("rejects a caller without a session", async () => {
    sessionRef.current = null;
    const response = await call();
    expect(response.status).toBe(401);
  });

  it("does not mint a url for an unknown staff member", async () => {
    const response = await call("?staffId=nosuchstaff");
    const raw = JSON.stringify(await json(response));
    expect(response.status).toBe(404);
    expect(raw).not.toContain("v1.");
  });

  it("does not mint a url for a deactivated staff member", async () => {
    staffRows[OTHER_STAFF_ID] = { id: OTHER_STAFF_ID, displayName: "Marco", active: false };
    const response = await call(`?staffId=${OTHER_STAFF_ID}`);
    staffRows[OTHER_STAFF_ID] = { id: OTHER_STAFF_ID, displayName: "Marco", active: true };

    expect(response.status).toBe(404);
  });

  it("reports an account without a team profile instead of guessing one", async () => {
    sessionRef.current = sessionFor("manager", "user-no-profile");
    const response = await call();
    expect(response.status).toBe(404);
  });
});

describe("GET /api/calendar/feed-url input handling", () => {
  it("rejects a staff id that is not an opaque identifier", async () => {
    const response = await call("?staffId=..%2F..%2Fetc");
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("VALIDATION_ERROR");
    expect(staffFindUnique).not.toHaveBeenCalled();
  });

  it("rejects unknown query parameters", async () => {
    const response = await call(`?staffId=${OWN_STAFF_ID}&role=owner`);
    expect(response.status).toBe(400);
  });

  it("meters credential lookups with the sensitive policy", async () => {
    const policy = ADMIN_RATE_LIMIT_POLICIES.adminSensitive;
    const ceiling = policy.limit + (policy.burst ?? 0);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await call(`?staffId=${OWN_STAFF_ID}`)).status).toBe(200);
    }
    expect((await call(`?staffId=${OWN_STAFF_ID}`)).status).toBe(429);
  });
});
