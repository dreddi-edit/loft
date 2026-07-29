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
const listServices = vi.fn();
const upsertConversationMessage = vi.fn();

vi.mock("@hair-simo/ai", async () => {
  const actual = await vi.importActual<typeof import("@hair-simo/ai")>("@hair-simo/ai");
  return { ...actual, runAssistant: (...args: unknown[]) => runAssistant(...args) };
});

vi.mock("@hair-simo/core", () => ({
  salonRepository: {
    listServices: (...args: unknown[]) => listServices(...args),
    upsertConversationMessage: (...args: unknown[]) => upsertConversationMessage(...args),
  },
}));

vi.mock("../../../../lib/ai-tools", () => ({
  createAiTools: () => ({}),
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/chat/web", {
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
  runAssistant.mockReset();
  listServices.mockReset();
  upsertConversationMessage.mockReset();
  runAssistant.mockResolvedValue({
    response: "Gerne!",
    locale: "de",
    intent: "booking_create",
    provider: "gemini",
  });
  listServices.mockResolvedValue([
    { slug: "damen-schnitt", translations: [{ locale: "de", name: "Damenschnitt" }] },
  ]);
  upsertConversationMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/chat/web", () => {
  it("answers and persists both turns of the conversation", async () => {
    const response = await POST(jsonRequest({ text: "Ich moechte buchen", locale: "de" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.response).toBe("Gerne!");
    expect(Array.isArray(body.data.actions)).toBe(true);
    expect(upsertConversationMessage).toHaveBeenCalledTimes(2);
    expect(upsertConversationMessage.mock.calls[0][0]).toMatchObject({ role: "user" });
    expect(upsertConversationMessage.mock.calls[1][0]).toMatchObject({ role: "assistant" });
  });

  it("keys the conversation on the resolved client address, not the forged header entry", async () => {
    await POST(
      jsonRequest(
        { text: "Ich moechte buchen" },
        { "x-forwarded-for": `198.51.100.99, ${CLOUD_RUN_CHAIN}` },
      ),
    );

    for (const [call] of upsertConversationMessage.mock.calls) {
      expect(call.externalRef).toBe("web:203.0.113.7");
      expect(call.externalRef).not.toContain("198.51.100.99");
    }
  });

  it("returns 400 with field-level detail for an empty utterance", async () => {
    const response = await POST(jsonRequest({ text: "" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details[0].path).toBe("text");
    expect(runAssistant).not.toHaveBeenCalled();
    expect(upsertConversationMessage).not.toHaveBeenCalled();
  });

  it("bounds the utterance, the identifiers and the replayed history", async () => {
    const long = await POST(jsonRequest({ text: "x".repeat(1_001) }));
    expect(long.status).toBe(400);
    expect((await long.json()).details[0].path).toBe("text");

    const wideId = await POST(jsonRequest({ text: "hi", customerId: "c".repeat(65) }));
    expect(wideId.status).toBe(400);
    expect((await wideId.json()).details[0].path).toBe("customerId");

    const deepHistory = await POST(
      jsonRequest({
        text: "hi",
        conversationHistory: Array.from({ length: 11 }, () => ({ role: "user", text: "hi" })),
      }),
    );
    expect(deepHistory.status).toBe(400);
    expect((await deepHistory.json()).details[0].path).toBe("conversationHistory");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body before the model is called", async () => {
    const response = await POST(jsonRequest({ text: "hi", padding: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/chat/web"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the chat policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.chat);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ text: "hallo" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ text: "hallo" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("maps an upstream model failure onto the taxonomy", async () => {
    runAssistant.mockRejectedValue(new Error("VERTEX_REQUEST_FAILED:503:backend unavailable"));
    const response = await POST(jsonRequest({ text: "hallo" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("never leaks a persistence failure to the client", async () => {
    upsertConversationMessage.mockRejectedValue(
      new Error(
        "Invalid `prisma.conversationMessage.upsert()` invocation in /app/packages/db/src/client.ts:33 " +
          "Unique constraint failed on the fields: (`externalRef`)",
      ),
    );

    const response = await POST(jsonRequest({ text: "hallo" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Unique constraint");
    expect(encoded).not.toContain("/app/packages");
  });
});
