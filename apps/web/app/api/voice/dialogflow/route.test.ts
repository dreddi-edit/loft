import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { resetRouteSecretWarnings } from "../../_lib/route-secret";

const runAssistant = vi.fn();
const callLogCreate = vi.fn();
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

vi.mock("@hair-simo/gcp/text-to-speech", () => ({
  synthesizeSpeechBase64: (...args: unknown[]) => synthesizeSpeechBase64(...args),
}));

/**
 * The workspace alias in vitest.config.ts only covers the "@hair-simo/gcp" root, so the
 * subpath the route imports at runtime cannot be resolved by the test runner. The real
 * module is loaded from source instead of being stubbed, so the envelope parsing under
 * test is the same code that runs in production.
 */
vi.mock("@hair-simo/gcp/dialogflow", async () =>
  vi.importActual("../../../../../../packages/gcp/src/dialogflow"),
);

vi.mock("../../../../lib/ai-tools", () => ({
  createAiTools: () => ({}),
}));

const SECRET = "df_2b1a0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b";
const HEADER = "x-dialogflow-webhook-secret";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const { POST } = await import("./route");

function webhookBody(text = "Vorrei prenotare", confidence = 0.93) {
  return {
    session: "projects/hair-simo/locations/eu/agents/a/sessions/s1",
    queryResult: {
      queryText: text,
      languageCode: "it-IT",
      intent: { displayName: "booking" },
      intentDetectionConfidence: confidence,
      parameters: { serviceId: "damen-schnitt" },
    },
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/voice/dialogflow", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authorised(body: unknown = webhookBody()): NextRequest {
  return jsonRequest(body, { [HEADER]: SECRET });
}

function spokenText(payload: {
  fulfillmentResponse: { messages: Array<{ text?: { text: string[] } }> };
}): string {
  return payload.fulfillmentResponse.messages
    .map((message) => message.text?.text.join(" ") ?? "")
    .join(" ");
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  resetRouteSecretWarnings();
  runAssistant.mockReset();
  callLogCreate.mockReset();
  synthesizeSpeechBase64.mockReset();
  runAssistant.mockResolvedValue({
    response: "Ti aspettiamo domani alle 10.",
    locale: "it",
    intent: "booking_create",
    provider: "gemini",
  });
  callLogCreate.mockResolvedValue({ id: "call_1" });
  synthesizeSpeechBase64.mockResolvedValue({ audioBase64: "" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GCP_DIALOGFLOW_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/voice/dialogflow route secret", () => {
  it("rejects a request without the custom header", async () => {
    const response = await POST(jsonRequest(webhookBody()));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: safeMessageForCode("UNAUTHORIZED"),
    });
    expect(runAssistant).not.toHaveBeenCalled();
    expect(callLogCreate).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret with 401 and not with a friendly spoken error", async () => {
    const response = await POST(jsonRequest(webhookBody(), { [HEADER]: "not-the-secret" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body).not.toHaveProperty("fulfillmentResponse");
    expect(callLogCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty header value", async () => {
    const response = await POST(jsonRequest(webhookBody(), { [HEADER]: "   " }));
    expect(response.status).toBe(401);
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("accepts the configured secret", async () => {
    const response = await POST(authorised());
    expect(response.status).toBe(200);
    expect(spokenText(await response.json())).toContain("Ti aspettiamo domani");
  });

  it("is fail-closed: requiring the secret in production without a value throws", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_DIALOGFLOW_WEBHOOK_SECRET", "");
    resetRouteSecretWarnings();

    await expect(import("./route")).rejects.toThrow(
      /SHARED_SECRET_MISSING:GCP_DIALOGFLOW_WEBHOOK_SECRET/,
    );
    vi.resetModules();
  });
});

describe("POST /api/voice/dialogflow fulfilment", () => {
  it("hands over to a human when the utterance is not understood confidently", async () => {
    const response = await POST(authorised(webhookBody("si", 0.2)));
    expect(response.status).toBe(200);
    expect(spokenText(await response.json())).toContain("could not confidently process");
    expect(callLogCreate.mock.calls[0][0].data).toMatchObject({
      fallback: true,
      actionTaken: "fallback-human-handover",
    });
  });

  it("answers with a generic failure message and no detail when fulfilment breaks", async () => {
    runAssistant.mockRejectedValue(
      new Error(
        "VERTEX_REQUEST_FAILED:503 for project hair-simo key=AIzaSyDEADBEEF " +
          "at /app/packages/ai/src/index.ts:212",
      ),
    );

    const response = await POST(authorised());
    expect(response.status).toBe(200);
    const body = await response.json();
    const encoded = JSON.stringify(body);
    expect(spokenText(body)).toBe("An error occurred. Please try again or call us directly.");
    expect(encoded).not.toContain("AIzaSy");
    expect(encoded).not.toContain("VERTEX_REQUEST_FAILED");
    expect(encoded).not.toContain("/app/packages");
  });

  it("returns a taxonomy error when the webhook envelope itself is malformed", async () => {
    const response = await POST(authorised({ queryResult: { queryText: 42 } }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(safeMessageForCode("VALIDATION_ERROR"));
    expect(callLogCreate).not.toHaveBeenCalled();
  });

  it("truncates the spoken answer instead of paying to synthesise an essay", async () => {
    runAssistant.mockResolvedValue({
      response: "a".repeat(900),
      locale: "it",
      intent: "faq_opening_hours",
      provider: "gemini",
    });

    const response = await POST(authorised());
    expect(response.status).toBe(200);
    expect(spokenText(await response.json())).toHaveLength(600);
    expect(synthesizeSpeechBase64).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized webhook body", async () => {
    const response = await POST(authorised({ ...webhookBody(), padding: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/voice/dialogflow"));
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
    expect(blocked.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});
