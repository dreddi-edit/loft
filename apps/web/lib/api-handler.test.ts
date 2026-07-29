import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ERROR_CODES,
  HttpError,
  isErrorCode,
  normalizeError,
  safeMessageForCode,
  serializeError,
  statusForCode,
} from "./api-errors";
import {
  REQUEST_ID_HEADER,
  apiRoute,
  resetApiLogSink,
  setApiLogSink,
  type LogRecord,
} from "./api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "./rate-limit";
import { resetSharedSecretWarnings } from "./shared-secret";

const SECRET = "b3f0d0e0c9a84a1fb2c1e5d9a7f4c2b6d8e0f1a3";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  resetSharedSecretWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function jsonRequest(
  body: unknown,
  init: { url?: string; method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(init.url ?? "https://hairsimo.it/api/test", {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...init.headers,
    },
    body: JSON.stringify(body),
  });
}

describe("apiRoute happy path", () => {
  it("serialises a plain object, stamps a request id and logs one structured line", async () => {
    const route = apiRoute(
      { route: "/api/test", schema: z.object({ name: z.string() }) },
      ({ body }) => ({
        data: { greeting: `hello ${body.name}` },
      }),
    );

    const response = await route(jsonRequest({ name: "simo" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { greeting: "hello simo" } });
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      severity: "INFO",
      requestId,
      route: "/api/test",
      method: "POST",
      status: 200,
      clientIp: "203.0.113.7",
    });
    expect(typeof logs[0].durationMs).toBe("number");
    expect(() => JSON.parse(JSON.stringify(logs[0]))).not.toThrow();
  });

  it("passes a Response through untouched apart from the response headers", async () => {
    const route = apiRoute({}, () => NextResponse.json({ ok: true }, { status: 201 }));
    const response = await route(jsonRequest({}));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("honours successStatus for object returns", async () => {
    const route = apiRoute({ successStatus: 201 }, () => ({ data: { id: "apt_1" } }));
    expect((await route(jsonRequest({}))).status).toBe(201);
  });

  it("propagates a Cloud Trace id into the log line", async () => {
    const route = apiRoute({}, () => ({ ok: true }));
    await route(jsonRequest({}, { headers: { "x-cloud-trace-context": "abc123def456/1;o=1" } }));
    expect(logs[0].traceId).toBe("abc123def456");
  });
});

describe("apiRoute params handling", () => {
  it("preserves the Next 16 promise-shaped params argument", async () => {
    const seen: { token?: string; isPromise?: boolean } = {};
    const route = apiRoute<unknown, undefined, { token: string }>({}, async ({ params, ctx }) => {
      seen.token = params.token;
      seen.isPromise = typeof (ctx.params as Promise<unknown>).then === "function";
      return { data: params.token };
    });

    const response = await route(jsonRequest({}), { params: Promise.resolve({ token: "tok_42" }) });

    expect(await response.json()).toEqual({ data: "tok_42" });
    expect(seen).toEqual({ token: "tok_42", isPromise: true });
  });

  it("works for static routes that receive no context", async () => {
    const route = apiRoute({}, ({ params }) => ({ data: params }));
    expect(await (await route(jsonRequest({}))).json()).toEqual({ data: {} });
  });
});

describe("apiRoute 405 method guard", () => {
  it("rejects a method outside the allowlist", async () => {
    const route = apiRoute({ methods: ["POST"] }, () => ({ ok: true }));
    const response = await route(
      new NextRequest("https://hairsimo.it/api/test", { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("apiRoute 429 rate limiting", () => {
  it("blocks past limit + burst and emits RateLimit-* plus Retry-After", async () => {
    const route = apiRoute({ route: "/api/contact", policy: "contact" }, () => ({ ok: true }));
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);

    for (let index = 0; index < ceiling; index += 1) {
      const ok = await route(jsonRequest({}));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("RateLimit-Limit")).toBe(String(ceiling));
      expect(ok.headers.get("RateLimit-Remaining")).toBe(String(ceiling - index - 1));
    }

    const blocked = await route(jsonRequest({}));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: "RATE_LIMITED",
      message: safeMessageForCode("RATE_LIMITED"),
    });
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked.headers.get("RateLimit-Remaining")).toBe("0");
    expect(logs.at(-1)).toMatchObject({
      severity: "WARNING",
      status: 429,
      errorCode: "RATE_LIMITED",
    });
  });

  it("cannot be escaped by forging the leftmost x-forwarded-for entry", async () => {
    const route = apiRoute({ policy: "contact" }, () => ({ ok: true }));
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);

    for (let index = 0; index < ceiling; index += 1) {
      const response = await route(
        jsonRequest({}, { headers: { "x-forwarded-for": `10.0.0.${index}, ${CLOUD_RUN_CHAIN}` } }),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await route(
      jsonRequest({}, { headers: { "x-forwarded-for": `10.0.0.99, ${CLOUD_RUN_CHAIN}` } }),
    );
    expect(blocked.status).toBe(429);
  });

  it("supports a custom rate limit key", async () => {
    const route = apiRoute(
      { policy: "contact", rateLimitKey: ({ req }) => req.headers.get("x-tenant") ?? "anon" },
      () => ({ ok: true }),
    );
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await route(jsonRequest({}, { headers: { "x-tenant": "a" } }))).status).toBe(200);
    }
    expect((await route(jsonRequest({}, { headers: { "x-tenant": "a" } }))).status).toBe(429);
    expect((await route(jsonRequest({}, { headers: { "x-tenant": "b" } }))).status).toBe(200);
  });
});

describe("apiRoute 400 validation", () => {
  it("returns safe field-level detail without echoing the submitted values", async () => {
    const schema = z.object({ name: z.string().min(2), age: z.number().int() });
    const route = apiRoute({ schema }, () => ({ ok: true }));

    const response = await route(jsonRequest({ name: "s", age: "not-a-number" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(safeMessageForCode("VALIDATION_ERROR"));
    expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
    expect(body.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
      "age",
      "name",
    ]);
    expect(JSON.stringify(body)).not.toContain("not-a-number");
  });

  it("rejects malformed JSON", async () => {
    const request = new NextRequest("https://hairsimo.it/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    const route = apiRoute({}, () => ({ ok: true }));
    const response = await route(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "VALIDATION_ERROR",
      message: "Request body is not valid JSON.",
    });
  });

  it("validates query parameters", async () => {
    const route = apiRoute(
      {
        methods: ["GET"],
        query: z.object({ serviceSlug: z.string().min(1), day: z.iso.date() }),
      },
      ({ query }) => ({ data: query }),
    );

    const ok = await route(
      new NextRequest("https://hairsimo.it/api/availability?serviceSlug=cut&day=2026-08-01"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { serviceSlug: "cut", day: "2026-08-01" } });

    const bad = await route(
      new NextRequest("https://hairsimo.it/api/availability?serviceSlug=cut&day=whenever"),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).details[0].path).toBe("day");
  });

  it("treats an empty body as an empty object so defaults apply", async () => {
    const route = apiRoute(
      { schema: z.object({ withinHours: z.number().default(24) }) },
      ({ body }) => ({ data: body.withinHours }),
    );
    const request = new NextRequest("https://hairsimo.it/api/test", { method: "POST" });
    expect(await (await route(request)).json()).toEqual({ data: 24 });
  });
});

describe("apiRoute 413 and 415 body caps", () => {
  it("rejects an oversized JSON body from the content-length header", async () => {
    const route = apiRoute({ bodyLimitBytes: 64 }, () => ({ ok: true }));
    const response = await route(jsonRequest({ text: "x".repeat(500) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects an oversized streamed body that declares no content-length", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(4_000) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, 2_000));
        controller.enqueue(payload.slice(2_000));
        controller.close();
      },
    });
    type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
    const request = new NextRequest("https://hairsimo.it/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as NextRequestInit & { duplex: "half" });

    expect(request.headers.get("content-length")).toBeNull();
    const route = apiRoute({ bodyLimitBytes: 1_000 }, () => ({ ok: true }));
    const response = await route(request);
    expect(response.status).toBe(413);
  });

  it("caps multipart uploads before the blob is buffered", async () => {
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(300_000)], { type: "audio/webm" }), "clip.webm");
    const request = new NextRequest("https://hairsimo.it/api/voice/transcribe", {
      method: "POST",
      body: form,
    });

    const route = apiRoute({ accept: ["form"], uploadLimitBytes: 64_000 }, () => ({ ok: true }));
    const response = await route(request);
    expect(response.status).toBe(413);
  });

  it("parses multipart uploads under the cap and preserves the file entry", async () => {
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(1_024)], { type: "audio/webm" }), "clip.webm");
    form.set("encoding", "WEBM_OPUS");
    const request = new NextRequest("https://hairsimo.it/api/voice/transcribe", {
      method: "POST",
      body: form,
    });

    let bytes = -1;
    const route = apiRoute({ accept: ["form"], uploadLimitBytes: 64_000 }, async ({ body }) => {
      const record = body as Record<string, unknown>;
      bytes = (await (record.audio as Blob).arrayBuffer()).byteLength;
      return { data: { encoding: record.encoding } };
    });

    const response = await route(request);
    expect(response.status).toBe(200);
    expect(bytes).toBe(1_024);
    expect(await response.json()).toEqual({ data: { encoding: "WEBM_OPUS" } });
  });

  it("rejects a content type the route does not accept", async () => {
    const request = new NextRequest("https://hairsimo.it/api/test", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: "<root/>",
    });
    const route = apiRoute({}, () => ({ ok: true }));
    const response = await route(request);
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

describe("apiRoute 401 shared secret", () => {
  it("rejects a request without the bearer token", async () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", SECRET);
    const route = apiRoute({ sharedSecret: "paymentWebhook" }, () => ({ received: true }));

    const denied = await route(jsonRequest({ paymentId: "pay_1", status: "succeeded" }));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error).toBe("UNAUTHORIZED");

    const wrong = await route(jsonRequest({}, { headers: { authorization: "Bearer nope" } }));
    expect(wrong.status).toBe(401);

    const allowed = await route(
      jsonRequest({}, { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses to construct a production route whose secret is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(() => apiRoute({ sharedSecret: "paymentWebhook" }, () => ({ ok: true }))).toThrow(
      /SHARED_SECRET_MISSING:paymentWebhook/,
    );
  });
});

describe("apiRoute error serialisation", () => {
  it("maps a plain core domain error onto its HTTP status", async () => {
    const route = apiRoute({}, () => {
      throw new Error("SLOT_NOT_AVAILABLE");
    });
    const response = await route(jsonRequest({}));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SLOT_NOT_AVAILABLE",
      message: safeMessageForCode("SLOT_NOT_AVAILABLE"),
    });
  });

  it("returns 500 INTERNAL and never leaks the raw error to the client", async () => {
    const leaky =
      "Invalid `prisma.appointment.create()` invocation in /app/packages/db/src/index.ts:41 " +
      "Unique constraint failed on the fields: (`customerId`,`startsAt`)";
    const route = apiRoute({ route: "/api/booking" }, () => {
      throw new Error(leaky);
    });

    const response = await route(jsonRequest({}));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(JSON.stringify(body)).not.toContain("Unique constraint");

    const logged = logs.at(-1);
    expect(logged).toMatchObject({ severity: "ERROR", status: 500, errorCode: "INTERNAL" });
    expect(String(logged?.error)).toContain("Unique constraint");
    expect(logged?.requestId).toBe(body.requestId);
  });

  it("keeps an explicit HttpError status and detail", async () => {
    const route = apiRoute({}, () => {
      throw new HttpError("PAYMENT_FAILED", { message: "Card was declined." });
    });
    const response = await route(jsonRequest({}));
    expect(response.status).toBe(402);
    expect((await response.json()).message).toBe("Card was declined.");
  });
});

describe("api-errors taxonomy", () => {
  it("defines a status and a safe message for every code", () => {
    for (const code of ERROR_CODES) {
      expect(statusForCode(code), code).toBeGreaterThanOrEqual(400);
      expect(safeMessageForCode(code).length, code).toBeGreaterThan(0);
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode("NOPE")).toBe(false);
  });

  it("maps known core error strings and falls back to INTERNAL", () => {
    expect(normalizeError(new Error("SERVICE_NOT_FOUND")).status).toBe(404);
    expect(normalizeError(new Error("STAFF_NOT_ELIGIBLE")).code).toBe("STAFF_NOT_ELIGIBLE");
    expect(normalizeError(new Error("PAYMENT_INTENT_MISSING")).code).toBe("PAYMENT_FAILED");
    expect(normalizeError(new Error("INVALID_CREDENTIALS")).status).toBe(401);
    expect(normalizeError(new Error("VERTEX_REQUEST_FAILED:503:quota exceeded")).code).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
    expect(normalizeError(new Error("something exploded")).code).toBe("INTERNAL");
    expect(normalizeError("a string").code).toBe("INTERNAL");
    expect(normalizeError(undefined).status).toBe(500);
  });

  it("never exposes configuration failures as domain errors", () => {
    for (const message of ["JWT_SECRET_MISSING", "IDENTITY_PLATFORM_NOT_ENABLED"]) {
      const normalized = normalizeError(new Error(message));
      expect(normalized.code).toBe("INTERNAL");
      const { body } = serializeError(new Error(message), "req-1");
      expect(JSON.stringify(body)).not.toContain(message);
    }
  });

  it("turns a ZodError into safe field-level detail", () => {
    const parsed = z.object({ email: z.string(), nested: z.object({ n: z.number() }) }).safeParse({
      email: 5,
      nested: { n: "x" },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const normalized = normalizeError(parsed.error);
    expect(normalized.code).toBe("VALIDATION_ERROR");
    expect(normalized.status).toBe(400);
    expect(normalized.details?.map((detail) => detail.path)).toEqual(["email", "nested.n"]);
  });

  it("carries the request id into the body so support can correlate", () => {
    const { body, status, logMessage } = serializeError(new Error("boom in prisma"), "req-77");
    expect(status).toBe(500);
    expect(body.requestId).toBe("req-77");
    expect(logMessage).toContain("boom in prisma");
  });
});
