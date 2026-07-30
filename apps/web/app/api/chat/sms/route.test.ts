import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { MAX_CHAT_TEXT_LENGTH } from "../../_lib/chat-channel";

const runAssistant = vi.fn();

vi.mock("@hair-simo/ai", () => ({
  runAssistant: (...args: unknown[]) => runAssistant(...args),
}));

vi.mock("../../../../lib/ai-tools", () => ({
  createAiTools: () => ({}),
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/chat/sms", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  runAssistant.mockReset();
  runAssistant.mockResolvedValue({
    response: "We are open until 18:00.",
    locale: "de",
    intent: "faq_opening_hours",
    provider: "gemini",
  });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/chat/sms", () => {
  it("answers a message and reports the channel it came in on", async () => {
    const response = await POST(jsonRequest({ text: "Wann habt ihr offen?", locale: "de" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: "sms",
      reply: "We are open until 18:00.",
      locale: "de",
      intent: "faq_opening_hours",
      provider: "gemini",
    });
    expect(runAssistant).toHaveBeenCalledWith(
      { text: "Wann habt ihr offen?", locale: "de" },
      expect.anything(),
    );
  });

  it("accepts the legacy message field", async () => {
    const response = await POST(jsonRequest({ message: "Ciao" }));
    expect(response.status).toBe(200);
    expect(runAssistant).toHaveBeenCalledWith(
      { text: "Ciao", locale: undefined },
      expect.anything(),
    );
  });

  it("rejects a body with neither text nor message", async () => {
    const response = await POST(jsonRequest({ locale: "de" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details[0].path).toBe("text");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("caps the utterance so one inbound message cannot buy an unbounded model call", async () => {
    const response = await POST(jsonRequest({ text: "x".repeat(MAX_CHAT_TEXT_LENGTH + 1) }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("text");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("rejects an unsupported locale", async () => {
    const response = await POST(jsonRequest({ text: "hi", locale: "es" }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("locale");
  });

  it("returns 413 before the body is parsed", async () => {
    const response = await POST(jsonRequest({ text: "hi", padding: "x".repeat(5_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/chat/sms"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the chat policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.chat);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ text: "hi" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ text: "hi" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("maps an upstream model failure onto the taxonomy", async () => {
    runAssistant.mockRejectedValue(new Error("VERTEX_REQUEST_FAILED:429:quota exceeded"));
    const response = await POST(jsonRequest({ text: "hi" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "UPSTREAM_UNAVAILABLE",
      message: safeMessageForCode("UPSTREAM_UNAVAILABLE"),
    });
  });

  it("never leaks an API key or an upstream URL to the client", async () => {
    runAssistant.mockRejectedValue(
      new Error(
        "request to https://europe-west4-aiplatform.googleapis.com/v1/projects/hair-simo " +
          "failed with key=AIzaSyDEADBEEF at /app/packages/ai/src/index.ts:212",
      ),
    );

    const response = await POST(jsonRequest({ text: "hi" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("AIzaSy");
    expect(encoded).not.toContain("googleapis.com");
    expect(encoded).not.toContain("/app/packages");
  });
});
