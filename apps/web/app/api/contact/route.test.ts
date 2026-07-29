import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";

const send = vi.fn();

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  NotificationService: class {
    send = send;
  },
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const VALID_BODY = {
  name: "Anna Bianchi",
  email: "anna@example.com",
  message: "Do you open on Mondays?",
  locale: "it",
};

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  send.mockReset();
  send.mockResolvedValue({ status: "sent" });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/contact", () => {
  it("delivers to the salon inbox and answers with nothing but ok", async () => {
    vi.stubEnv("CONTACT_INBOX_EMAIL", "info@hairsimo.it");
    const response = await POST(jsonRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      channel: "web",
      recipient: "info@hairsimo.it",
      subject: "Contact form: Anna Bianchi",
      message: "From: Anna Bianchi <anna@example.com>\n\nDo you open on Mondays?",
      locale: "it",
    });
  });

  it("cannot be used as an open relay: the recipient is never taken from the body", async () => {
    vi.stubEnv("CONTACT_INBOX_EMAIL", "info@hairsimo.it");
    const response = await POST(
      jsonRequest({
        ...VALID_BODY,
        recipient: "victim@example.org",
        to: "victim@example.org",
        channel: "sms",
        subject: "You have won",
      }),
    );

    expect(response.status).toBe(200);
    const [payload] = send.mock.calls[0];
    expect(payload.recipient).toBe("info@hairsimo.it");
    expect(payload.channel).toBe("web");
    expect(payload.subject).toBe("Contact form: Anna Bianchi");
    expect(JSON.stringify(payload)).not.toContain("victim@example.org");
  });

  it("returns 400 with field-level detail for an invalid submission", async () => {
    const response = await POST(jsonRequest({ name: "", email: "not-an-email", message: "hi" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(safeMessageForCode("VALIDATION_ERROR"));
    expect(body.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
      "email",
      "message",
      "name",
    ]);
    expect(JSON.stringify(body)).not.toContain("not-an-email");
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds the message and the name", async () => {
    const response = await POST(
      jsonRequest({ ...VALID_BODY, name: "n".repeat(101), message: "m".repeat(2_001) }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path).sort(),
    ).toEqual(["message", "name"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 413 before the notification service is reached", async () => {
    const response = await POST(jsonRequest({ ...VALID_BODY, message: "m".repeat(9_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/contact"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the contact policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest(VALID_BODY))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest(VALID_BODY));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
    expect(send).toHaveBeenCalledTimes(ceiling);
  });

  it("never leaks the mail transport failure to the client", async () => {
    send.mockRejectedValue(
      new Error("535 5.7.8 Username and Password not accepted for smtp-relay@hairsimo.it"),
    );

    const response = await POST(jsonRequest(VALID_BODY));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("Password not accepted");
    expect(encoded).not.toContain("smtp-relay@hairsimo.it");
  });
});
