import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { resetSharedSecretWarnings } from "../../../../lib/shared-secret";

const dispatchDueReminders = vi.fn();

vi.mock("@hair-simo/core", () => ({
  ReminderService: class {
    dispatchDueReminders = dispatchDueReminders;
  },
}));

const SECRET = "1f0a9c8b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { POST } = await import("./route");

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/cron/reminders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authorised(body: unknown = {}): NextRequest {
  return jsonRequest(body, { authorization: `Bearer ${SECRET}` });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  resetSharedSecretWarnings();
  dispatchDueReminders.mockReset();
  dispatchDueReminders.mockResolvedValue({ dispatched: 3, skipped: 0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GCP_CLOUD_TASKS_SECRET", SECRET);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/cron/reminders shared secret", () => {
  it("rejects a request with no authorization header", async () => {
    const response = await POST(jsonRequest({}));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: safeMessageForCode("UNAUTHORIZED"),
    });
    expect(dispatchDueReminders).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret and a secret in the wrong scheme", async () => {
    const wrong = await POST(jsonRequest({}, { authorization: "Bearer not-the-secret" }));
    expect(wrong.status).toBe(401);

    const raw = await POST(jsonRequest({}, { authorization: SECRET }));
    expect(raw.status).toBe(401);

    const empty = await POST(jsonRequest({}, { authorization: "Bearer " }));
    expect(empty.status).toBe(401);

    expect(dispatchDueReminders).not.toHaveBeenCalled();
  });

  it("accepts the configured secret and dispatches the batch", async () => {
    const response = await POST(authorised({ withinHours: 12 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { dispatched: 3, skipped: 0 } });
    expect(dispatchDueReminders).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("also accepts the CRON_SECRET fallback of the same registry entry", async () => {
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "");
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(authorised())).status).toBe(200);
  });

  it("is fail-closed: constructing the route in production without a secret throws", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    resetSharedSecretWarnings();

    await expect(import("./route")).rejects.toThrow(/SHARED_SECRET_MISSING:cron/);
    vi.resetModules();
  });
});

describe("POST /api/cron/reminders request handling", () => {
  it("defaults the window and bounds it at one week", async () => {
    expect((await POST(authorised({}))).status).toBe(200);
    expect(dispatchDueReminders).toHaveBeenCalledWith(24);

    const tooWide = await POST(authorised({ withinHours: 24 * 8 }));
    expect(tooWide.status).toBe(400);
    expect((await tooWide.json()).details[0].path).toBe("withinHours");

    const negative = await POST(authorised({ withinHours: -1 }));
    expect(negative.status).toBe(400);
    expect(dispatchDueReminders).toHaveBeenCalledTimes(1);
  });

  it("validates the body before checking the secret is not required to leak anything", async () => {
    const response = await POST(authorised({ withinHours: "many" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("returns 413 for an oversized body without ever reaching the service", async () => {
    const response = await POST(authorised({ withinHours: 24, padding: "x".repeat(2_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(dispatchDueReminders).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/cron/reminders"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the internal policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.internal);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(authorised())).status).toBe(200);
    }
    const blocked = await POST(authorised());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("never leaks the reminder service failure to the client", async () => {
    dispatchDueReminders.mockRejectedValue(
      new Error(
        "Invalid `prisma.notificationLog.createMany()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );

    const response = await POST(authorised());
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

describe("the reminder route deleted by the security audit stays deleted", () => {
  it("has no module at /api/notifications/reminder", () => {
    const dir = path.join(API_DIR, "notifications", "reminder");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(API_DIR, "notifications"))).toBe(false);
  });
});
