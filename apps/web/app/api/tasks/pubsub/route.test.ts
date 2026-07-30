import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiLogSink, setApiLogSink, REQUEST_ID_HEADER } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

const deliverPubSubEvent = vi.fn();

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  NotificationService: class {
    deliverPubSubEvent = deliverPubSubEvent;
  },
}));

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const EVENT = {
  channel: "sms" as const,
  recipient: "+393331234567",
  locale: "it" as const,
  payload: { subject: "Hair Simo", message: "Your appointment is tomorrow at 09:00." },
};

const { POST } = await import("./route");

function envelope(event: typeof EVENT = EVENT, messageId = "msg_1") {
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString("base64"),
      messageId,
      publishTime: "2026-07-29T10:00:00.000Z",
    },
    subscription: "projects/hair-simo/subscriptions/notifications-push",
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/tasks/pubsub", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  deliverPubSubEvent.mockReset();
  deliverPubSubEvent.mockResolvedValue({ status: "sent", provider: "twilio" });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/tasks/pubsub auth boundary", () => {
  it("rejects a production push without a bearer token", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(jsonRequest(envelope()));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(deliverPubSubEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/tasks/pubsub payload handling", () => {
  it("delivers a decoded Pub/Sub notification event", async () => {
    const response = await POST(jsonRequest(envelope()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "sent", messageId: "msg_1" });
    expect(deliverPubSubEvent).toHaveBeenCalledExactlyOnceWith({
      channel: EVENT.channel,
      recipient: EVENT.recipient,
      locale: EVENT.locale,
      payload: EVENT.payload,
    });
  });

  it("returns 400 when the base64 payload is not a valid notification event", async () => {
    const badData = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    const response = await POST(jsonRequest({ message: { data: badData } }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(deliverPubSubEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when delivery fails upstream", async () => {
    deliverPubSubEvent.mockResolvedValue({ status: "failed", provider: "twilio", reason: "TIMEOUT" });

    const response = await POST(jsonRequest(envelope()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.message).toBe("Notification delivery failed.");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("returns 413 for an oversized envelope before decoding", async () => {
    const response = await POST(jsonRequest({ message: { data: "x".repeat(70_000) } }));

    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(deliverPubSubEvent).not.toHaveBeenCalled();
  });

  it("returns 429 once the internal rate limit is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.internal);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest(envelope()))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest(envelope()));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
