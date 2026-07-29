import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

const transcribeAudio = vi.fn();

vi.mock("@hair-simo/gcp/speech-to-text", () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const MAX_AUDIO_UPLOAD_BYTES = 1_048_576;

function uploadRequest(form: FormData): NextRequest {
  return new NextRequest("https://hairsimo.it/api/voice/transcribe", {
    method: "POST",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: form,
  });
}

function clipForm(bytes: number, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(bytes)], { type: "audio/webm" }), "clip.webm");
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue({ transcript: "Buongiorno", confidence: 0.94 });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/voice/transcribe", () => {
  it("transcribes a small clip with the declared encoding", async () => {
    const response = await POST(
      uploadRequest(clipForm(2_048, { encoding: "OGG_OPUS", sampleRateHertz: "16000" })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { transcript: "Buongiorno", confidence: 0.94 } });
    const [payload] = transcribeAudio.mock.calls[0];
    expect(payload.encoding).toBe("OGG_OPUS");
    expect(payload.sampleRateHertz).toBe(16_000);
    expect(payload.audioContent.byteLength).toBe(2_048);
  });

  it("defaults the encoding and the sample rate", async () => {
    await POST(uploadRequest(clipForm(512)));
    expect(transcribeAudio.mock.calls[0][0]).toMatchObject({
      encoding: "WEBM_OPUS",
      sampleRateHertz: 48_000,
    });
  });

  it("returns 413 for an oversized upload before the blob is buffered", async () => {
    const response = await POST(uploadRequest(clipForm(MAX_AUDIO_UPLOAD_BYTES + 4_096)));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("rejects a JSON body because the route only accepts multipart", async () => {
    const response = await POST(
      new NextRequest("https://hairsimo.it/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: "AAAA" }),
      }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("returns 400 when the audio part is missing or is not a file", async () => {
    const missing = new FormData();
    missing.set("encoding", "WEBM_OPUS");
    const response = await POST(uploadRequest(missing));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("audio");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("rejects an unsupported encoding and an out-of-range sample rate", async () => {
    const encoding = await POST(uploadRequest(clipForm(512, { encoding: "FLAC" })));
    expect(encoding.status).toBe(400);
    expect((await encoding.json()).details[0].path).toBe("encoding");

    const rate = await POST(uploadRequest(clipForm(512, { sampleRateHertz: "192000" })));
    expect(rate.status).toBe(400);
    expect((await rate.json()).details[0].path).toBe("sampleRateHertz");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/voice/transcribe"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the voice policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.voice);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(uploadRequest(clipForm(256)))).status).toBe(200);
    }
    const blocked = await POST(uploadRequest(clipForm(256)));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("never leaks the speech API failure to the client", async () => {
    transcribeAudio.mockRejectedValue(
      new Error(
        "speech.googleapis.com 401 UNAUTHENTICATED for stt@hair-simo.iam.gserviceaccount.com " +
          "at /app/packages/gcp/src/speech-to-text.ts:64",
      ),
    );

    const response = await POST(uploadRequest(clipForm(256)));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("gserviceaccount.com");
    expect(encoded).not.toContain("/app/packages");
  });
});
