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
const callLogCreate = vi.fn();
const isGcpConfigured = vi.fn();
const synthesizeSpeechBase64 = vi.fn();

vi.mock("@hair-simo/ai", () => ({
  runAssistant: (...args: unknown[]) => runAssistant(...args),
}));

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },

  runWithTenantAsync: async (_ctx: unknown, fn: () => unknown) => fn(),
  prisma: {
    tenant: { findUnique: async () => ({ id: "cltenant00000000000000001", slug: "hairsimo-brixen", displayName: "Hair Simo", timeZone: "Europe/Rome", defaultLocale: "it", status: "active", settings: {} }) }, callLog: { create: (...args: unknown[]) => callLogCreate(...args) } },
}));

vi.mock("@hair-simo/gcp/config", () => ({
  isGcpConfigured: () => isGcpConfigured(),
}));

vi.mock("@hair-simo/gcp/text-to-speech", () => ({
  synthesizeSpeechBase64: (...args: unknown[]) => synthesizeSpeechBase64(...args),
}));

vi.mock("../../../../lib/ai-tools", () => ({
  createAiTools: () => ({}),
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/voice/simulate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  runAssistant.mockReset();
  callLogCreate.mockReset();
  isGcpConfigured.mockReset();
  synthesizeSpeechBase64.mockReset();
  runAssistant.mockResolvedValue({
    response: "Ti aspettiamo domani.",
    locale: "it",
    intent: "booking_create",
    provider: "gemini",
  });
  callLogCreate.mockResolvedValue({ id: "call_1" });
  isGcpConfigured.mockReturnValue(false);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/voice/simulate availability", () => {
  it("does not exist in production unless it is switched on deliberately", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(jsonRequest({ text: "Vorrei prenotare" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
    });
    expect(runAssistant).not.toHaveBeenCalled();
    expect(callLogCreate).not.toHaveBeenCalled();
  });

  it("runs in production only with the explicit opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VOICE_SIMULATOR_ENABLED", "true");
    expect((await POST(jsonRequest({ text: "Vorrei prenotare" }))).status).toBe(200);
    expect(runAssistant).toHaveBeenCalledTimes(1);
  });

  it("does not open on a truthy-looking value that is not exactly true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VOICE_SIMULATOR_ENABLED", "1");
    expect((await POST(jsonRequest({ text: "Vorrei prenotare" }))).status).toBe(404);
    expect(runAssistant).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/simulate request handling", () => {
  it("answers, records a call log and reports that it was simulated", async () => {
    const response = await POST(jsonRequest({ text: "Vorrei prenotare", locale: "it" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      simulated: true,
      audioBase64: null,
      intent: "booking_create",
    });
    expect(callLogCreate).toHaveBeenCalledTimes(1);
    expect(callLogCreate.mock.calls[0][0].data).toMatchObject({
      toNumber: "voice-simulator",
      fromNumber: "local-simulator",
    });
  });

  it("returns 400 with field-level detail for an empty or oversized utterance", async () => {
    const empty = await POST(jsonRequest({ text: "" }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).details[0].path).toBe("text");

    const long = await POST(jsonRequest({ text: "x".repeat(501) }));
    expect(long.status).toBe(400);
    expect((await long.json()).details[0].path).toBe("text");

    const phone = await POST(jsonRequest({ text: "hi", fromNumber: "9".repeat(31) }));
    expect(phone.status).toBe(400);
    expect((await phone.json()).details[0].path).toBe("fromNumber");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("returns 413 before the model and the call log are reached", async () => {
    const response = await POST(jsonRequest({ text: "hi", padding: "x".repeat(5_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(runAssistant).not.toHaveBeenCalled();
    expect(callLogCreate).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/voice/simulate"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the voice policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.voice);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ text: "ciao" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ text: "ciao" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("swallows a speech synthesis failure instead of failing the whole turn", async () => {
    isGcpConfigured.mockReturnValue(true);
    synthesizeSpeechBase64.mockRejectedValue(new Error("texttospeech.googleapis.com 429 quota"));

    const response = await POST(jsonRequest({ text: "ciao" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.audioBase64).toBeNull();
    expect(JSON.stringify(body)).not.toContain("googleapis.com");
  });

  it("never leaks the call log write failure to the client", async () => {
    callLogCreate.mockRejectedValue(
      new Error(
        "Invalid `prisma.callLog.create()` invocation in /app/packages/db/src/client.ts:33 " +
          "Foreign key constraint failed on the field: `customerId`",
      ),
    );

    const response = await POST(jsonRequest({ text: "ciao" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Foreign key constraint");
    expect(encoded).not.toContain("/app/packages");
  });
});
