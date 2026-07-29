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

const send = vi.fn();

vi.mock("@hair-simo/core", () => ({
  NotificationService: class {
    send = send;
  },
}));

const SECRET = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const { POST } = await import("./route");

const VALID_TASK = {
  type: "notification.send",
  data: {
    channel: "sms",
    recipient: "+393331234567",
    message: "Your appointment is tomorrow at 09:00.",
    locale: "it",
  },
};

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/tasks/notification", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authorised(body: unknown = VALID_TASK): NextRequest {
  return jsonRequest(body, { authorization: `Bearer ${SECRET}` });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  resetSharedSecretWarnings();
  send.mockReset();
  send.mockResolvedValue({ status: "sent" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GCP_CLOUD_TASKS_SECRET", SECRET);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/tasks/notification shared secret", () => {
  it("rejects a request with no authorization header", async () => {
    const response = await POST(jsonRequest(VALID_TASK));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: safeMessageForCode("UNAUTHORIZED"),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret so the queue cannot be driven by a stranger", async () => {
    const wrong = await POST(jsonRequest(VALID_TASK, { authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);

    const nearMiss = await POST(
      jsonRequest(VALID_TASK, { authorization: `Bearer ${SECRET.slice(0, -1)}0` }),
    );
    expect(nearMiss.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts the configured secret and sends the notification", async () => {
    const response = await POST(authorised());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handled: true, status: "sent" });
    expect(send).toHaveBeenCalledExactlyOnceWith(VALID_TASK.data);
  });

  it("is fail-closed: constructing the route in production without a secret throws", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "");
    resetSharedSecretWarnings();

    await expect(import("./route")).rejects.toThrow(/SHARED_SECRET_MISSING:cloudTasks/);
    vi.resetModules();
  });
});

describe("POST /api/tasks/notification payload handling", () => {
  it("ignores an unknown task type without sending anything", async () => {
    const response = await POST(authorised({ type: "appointment.delete", data: {} }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handled: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 400 with field-level detail for a malformed envelope", async () => {
    const response = await POST(authorised({ data: {} }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details[0].path).toBe("type");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an inner payload that names an unsupported channel or an unbounded message", async () => {
    const badChannel = await POST(
      authorised({ type: "notification.send", data: { ...VALID_TASK.data, channel: "pager" } }),
    );
    expect(badChannel.status).toBe(400);
    expect(badChannel.headers.get(REQUEST_ID_HEADER)).toBeTruthy();

    const longMessage = await POST(
      authorised({
        type: "notification.send",
        data: { ...VALID_TASK.data, message: "x".repeat(4_001) },
      }),
    );
    expect(longMessage.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized task before the secret check or the send", async () => {
    const response = await POST(
      authorised({ type: "notification.send", data: { padding: "x".repeat(9_000) } }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/tasks/notification"));
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

  it("never leaks the delivery failure to the client", async () => {
    send.mockRejectedValue(
      new Error("Twilio 20003 authentication failed for account AC0123456789abcdef"),
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
    expect(encoded).not.toContain("AC0123456789abcdef");
    expect(encoded).not.toContain("authentication failed");
  });
});
