import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

const synthesizeSpeechBase64 = vi.fn();

vi.mock("@hair-simo/gcp/text-to-speech", () => ({
  synthesizeSpeechBase64: (...args: unknown[]) => synthesizeSpeechBase64(...args),
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const MAX_SYNTHESIS_CHARS = 500;

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/voice/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  synthesizeSpeechBase64.mockReset();
  synthesizeSpeechBase64.mockResolvedValue({ audioBase64: "AAAA", voice: "it-IT-Standard-A" });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/voice/synthesize", () => {
  it("synthesises a bounded utterance", async () => {
    const response = await POST(jsonRequest({ text: "Buongiorno", locale: "it" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { audioBase64: "AAAA", voice: "it-IT-Standard-A" },
    });
    expect(synthesizeSpeechBase64).toHaveBeenCalledExactlyOnceWith({
      text: "Buongiorno",
      locale: "it",
    });
  });

  it("caps the character count because Cloud TTS is billed per character", async () => {
    const atLimit = await POST(jsonRequest({ text: "a".repeat(MAX_SYNTHESIS_CHARS) }));
    expect(atLimit.status).toBe(200);

    const overLimit = await POST(jsonRequest({ text: "a".repeat(MAX_SYNTHESIS_CHARS + 1) }));
    expect(overLimit.status).toBe(400);
    expect((await overLimit.json()).details[0].path).toBe("text");
    expect(synthesizeSpeechBase64).toHaveBeenCalledTimes(1);
  });

  it("returns 400 with field-level detail for an empty text or an unknown locale", async () => {
    const empty = await POST(jsonRequest({ text: "   " }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).details[0].path).toBe("text");

    const locale = await POST(jsonRequest({ text: "hi", locale: "es" }));
    expect(locale.status).toBe(400);
    expect((await locale.json()).details[0].path).toBe("locale");
    expect(synthesizeSpeechBase64).not.toHaveBeenCalled();
  });

  it("returns 413 before the paid API is called", async () => {
    const response = await POST(jsonRequest({ text: "hi", padding: "x".repeat(5_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(synthesizeSpeechBase64).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/voice/synthesize"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the voice policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.voice);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ text: "hi" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ text: "hi" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("never leaks the Google credential or endpoint to the client", async () => {
    synthesizeSpeechBase64.mockRejectedValue(
      new Error(
        "texttospeech.googleapis.com responded 403 for service account " +
          "tts@hair-simo.iam.gserviceaccount.com (key AIzaSyDEADBEEF)",
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
    expect(encoded).not.toContain("gserviceaccount.com");
    expect(encoded).not.toContain("googleapis.com");
  });
});
