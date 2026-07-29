import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

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
  return new NextRequest("https://hairsimo.it/api/chat/whatsapp", {
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
    response: "Certo, ti prenoto.",
    locale: "it",
    intent: "booking_create",
    provider: "gemini",
  });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/chat/whatsapp", () => {
  it("labels the reply with the whatsapp channel, not the sms one", async () => {
    const response = await POST(jsonRequest({ text: "Vorrei prenotare", locale: "it" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ channel: "whatsapp", reply: "Certo, ti prenoto." });
  });

  it("is an unauthenticated relay only to the assistant, never to a third party", async () => {
    const response = await POST(
      jsonRequest({ text: "Vorrei prenotare", to: "+39 333 0000000", recipient: "victim" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "channel",
      "intent",
      "locale",
      "provider",
      "reply",
    ]);
    expect(runAssistant).toHaveBeenCalledWith(
      { text: "Vorrei prenotare", locale: undefined },
      expect.anything(),
    );
    expect(JSON.stringify(body)).not.toContain("+39 333 0000000");
  });

  it("returns 400 with field-level detail for an empty message", async () => {
    const response = await POST(jsonRequest({ text: "   " }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("text");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("returns 413 before the body is parsed", async () => {
    const response = await POST(jsonRequest({ text: "ciao", padding: "x".repeat(5_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/chat/whatsapp"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the chat policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.chat);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ text: "ciao" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ text: "ciao" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("never leaks the assistant failure to the client", async () => {
    runAssistant.mockRejectedValue(new Error("ENOTFOUND aiplatform.googleapis.com at /app/node_modules/undici"));
    const response = await POST(jsonRequest({ text: "ciao" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("ENOTFOUND");
    expect(JSON.stringify(body)).not.toContain("node_modules");
  });
});
