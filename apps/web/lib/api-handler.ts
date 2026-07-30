import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { ZodError, ZodType } from "zod";
import { resolveTenantContext } from "@hair-simo/core";
import { runWithTenantAsync } from "@hair-simo/db";
import { HttpError, serializeError, validationErrorFromZod } from "./api-errors";
import { resolveClientIp, type ClientIpResult } from "./client-ip";
import {
  enforceRateLimit,
  rateLimitHeaders,
  type RateLimitPolicyName,
  type RateLimitResult,
} from "./rate-limit";
import { requireSharedSecret, verifySharedSecret, type SharedSecretName } from "./shared-secret";

export const REQUEST_ID_HEADER = "x-request-id";
export const DEFAULT_BODY_LIMIT_BYTES = 32_768;
export const DEFAULT_UPLOAD_LIMIT_BYTES = 1_048_576;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type BodyKind = "json" | "form" | "none";
export type RouteParams = Record<string, string | string[]>;
export type RouteContext<TParams extends RouteParams = RouteParams> = {
  params: Promise<TParams>;
};

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export type LogFields = Record<string, unknown>;
export type LogRecord = LogFields & { severity: LogSeverity; message: string };
export type LogSink = (record: LogRecord) => void;

const defaultSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.severity === "ERROR") console.error(line);
  else if (record.severity === "WARNING") console.warn(line);
  else console.log(line);
};

let activeSink: LogSink = defaultSink;

export function setApiLogSink(sink: LogSink): void {
  activeSink = sink;
}

export function resetApiLogSink(): void {
  activeSink = defaultSink;
}

export type ApiLogger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type ApiHandlerContext<TBody, TQuery, TParams extends RouteParams> = {
  req: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  ctx: RouteContext<TParams>;
  searchParams: URLSearchParams;
  requestId: string;
  clientIp: ClientIpResult;
  rateLimit: RateLimitResult | null;
  log: ApiLogger;
};

export type ApiHandlerResult = Response | Record<string, unknown> | readonly unknown[] | null;

export type ApiHandler<TBody, TQuery, TParams extends RouteParams> = (
  context: ApiHandlerContext<TBody, TQuery, TParams>,
) => Promise<ApiHandlerResult> | ApiHandlerResult;

export type RateLimitKeyContext = {
  req: NextRequest;
  clientIp: ClientIpResult;
  requestId: string;
};

export type ApiRouteConfig<TBody, TQuery> = {
  route?: string;
  methods?: readonly HttpMethod[];
  policy?: RateLimitPolicyName;
  rateLimitKey?: (context: RateLimitKeyContext) => string;
  bodyLimitBytes?: number;
  uploadLimitBytes?: number;
  accept?: readonly BodyKind[];
  schema?: ZodType<TBody>;
  query?: ZodType<TQuery>;
  sharedSecret?: SharedSecretName;
  successStatus?: number;
};

export type ApiRouteHandler<TParams extends RouteParams> = (
  request: NextRequest,
  context?: RouteContext<TParams>,
) => Promise<Response>;

function severityForStatus(status: number): LogSeverity {
  if (status >= 500) return "ERROR";
  if (status >= 400) return "WARNING";
  return "INFO";
}

function traceIdFrom(request: NextRequest): string | undefined {
  const header = request.headers.get("x-cloud-trace-context");
  if (!header) return undefined;
  const traceId = header.split("/", 1)[0].trim();
  return traceId === "" ? undefined : traceId;
}

function createLogger(base: LogFields): ApiLogger {
  const emit = (severity: LogSeverity, message: string, fields?: LogFields) => {
    activeSink({ severity, message, ...base, ...fields });
  };
  return {
    debug: (message, fields) => emit("DEBUG", message, fields),
    info: (message, fields) => emit("INFO", message, fields),
    warn: (message, fields) => emit("WARNING", message, fields),
    error: (message, fields) => emit("ERROR", message, fields),
  };
}

async function readBodyBytes(
  request: NextRequest,
  limitBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limitBytes) {
      throw new HttpError("PAYLOAD_TOO_LARGE", {
        logMessage: `content-length ${size} exceeds limit ${limitBytes}`,
      });
    }
  }

  const stream = request.body;
  if (!stream) {
    const buffered = new Uint8Array(await request.arrayBuffer());
    if (buffered.byteLength > limitBytes) {
      throw new HttpError("PAYLOAD_TOO_LARGE", {
        logMessage: `buffered body ${buffered.byteLength} exceeds limit ${limitBytes}`,
      });
    }
    return buffered;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      // Release rather than cancel: a socket-backed body stops flowing under backpressure
      // once we stop reading, and cancelling makes undici's in-process body pump enqueue
      // into an already closed stream, which surfaces as an unhandled rejection.
      reader.releaseLock();
      throw new HttpError("PAYLOAD_TOO_LARGE", {
        logMessage: `streamed body exceeded limit ${limitBytes}`,
      });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function bodyKindFromContentType(contentType: string): BodyKind {
  const value = contentType.toLowerCase();
  if (value.includes("application/json") || value.includes("+json")) return "json";
  if (value.includes("multipart/form-data")) return "form";
  if (value.includes("application/x-www-form-urlencoded")) return "form";
  return "none";
}

export type FormValue = FormDataEntryValue | FormDataEntryValue[];

function formDataToObject(form: FormData): Record<string, FormValue> {
  const result: Record<string, FormValue> = {};
  for (const [key, value] of form.entries()) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}

const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

async function parseRequestBody<TBody, TQuery>(
  request: NextRequest,
  config: ApiRouteConfig<TBody, TQuery>,
): Promise<unknown> {
  if (METHODS_WITHOUT_BODY.has(request.method.toUpperCase())) return {};

  const contentType = request.headers.get("content-type") ?? "";
  const accept = config.accept ?? (["json"] as const);
  const kind = bodyKindFromContentType(contentType);

  if (kind === "none") {
    if (contentType.trim() === "" || accept.includes("none")) return {};
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", {
      logMessage: `unsupported content-type "${contentType}"`,
    });
  }

  if (!accept.includes(kind)) {
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", {
      logMessage: `content-type "${contentType}" is not accepted by this route`,
    });
  }

  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");
  const limit = isMultipart
    ? (config.uploadLimitBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES)
    : (config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);

  const bytes = await readBodyBytes(request, limit);
  if (bytes.byteLength === 0) return {};

  if (kind === "json") {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new HttpError("VALIDATION_ERROR", {
        message: "Request body is not valid JSON.",
        logMessage: "json parse failed",
      });
    }
  }

  const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  return formDataToObject(form);
}

function parseWith<T>(schema: ZodType<T>, value: unknown, message?: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw validationErrorFromZod(parsed.error as ZodError, message);
}

function applyHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function toResponse(result: ApiHandlerResult, successStatus: number): Response {
  if (result instanceof Response) return result;
  return NextResponse.json(result ?? {}, { status: successStatus });
}

/**
 * Wraps a Next.js App Router handler with the shared request pipeline:
 * method guard, trusted client-IP extraction, rate limiting, request body size caps,
 * content-type negotiation, zod validation, shared-secret auth, and error serialisation.
 *
 * The second argument keeps the Next 16 shape `{ params: Promise<Params> }` and is passed
 * through to the handler both awaited (`params`) and raw (`ctx`).
 */
export function apiRoute<
  TBody = unknown,
  TQuery = undefined,
  TParams extends RouteParams = RouteParams,
>(
  config: ApiRouteConfig<TBody, TQuery>,
  handler: ApiHandler<TBody, TQuery, TParams>,
): ApiRouteHandler<TParams> {
  if (config.sharedSecret) requireSharedSecret(config.sharedSecret);

  return async (request, context) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const method = request.method.toUpperCase();
    const routeName = config.route ?? new URL(request.url).pathname;
    const routeContext: RouteContext<TParams> = context ?? {
      params: Promise.resolve({} as TParams),
    };
    const traceId = traceIdFrom(request);

    let rateLimit: RateLimitResult | null = null;
    let clientIp: ClientIpResult | null = null;

    const log = createLogger({
      requestId,
      route: routeName,
      method,
      ...(traceId ? { traceId } : {}),
    });

    const finish = (response: Response, status: number, extra?: LogFields): Response => {
      const headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };
      if (rateLimit) Object.assign(headers, rateLimitHeaders(rateLimit, Date.now()));
      applyHeaders(response, headers);
      activeSink({
        severity: severityForStatus(status),
        message: `${method} ${routeName} ${status}`,
        requestId,
        route: routeName,
        method,
        status,
        durationMs: Date.now() - startedAt,
        ...(traceId ? { traceId } : {}),
        ...(clientIp ? { clientIp: clientIp.ip, clientIpSource: clientIp.source } : {}),
        ...(rateLimit
          ? {
              policy: rateLimit.policy,
              rateLimitUsed: rateLimit.used,
              rateLimitLimit: rateLimit.limit,
            }
          : {}),
        ...extra,
      });
      return response;
    };

    try {
      if (config.methods && !config.methods.includes(method as HttpMethod)) {
        throw new HttpError("METHOD_NOT_ALLOWED", {
          logMessage: `method ${method} is not allowed on ${routeName}`,
        });
      }

      const resolvedClientIp = resolveClientIp(request.headers);
      clientIp = resolvedClientIp;

      if (config.policy) {
        const identifier = config.rateLimitKey
          ? config.rateLimitKey({ req: request, clientIp: resolvedClientIp, requestId })
          : resolvedClientIp.key;
        rateLimit = await enforceRateLimit(config.policy, identifier);
        if (!rateLimit.allowed) {
          throw new HttpError("RATE_LIMITED", {
            logMessage: `policy ${config.policy} exceeded for ${identifier}`,
          });
        }
      }

      const rawBody = await parseRequestBody(request, config);
      const searchParams = request.nextUrl.searchParams;

      const query = config.query
        ? parseWith(
            config.query,
            Object.fromEntries(searchParams.entries()),
            "Invalid query parameters.",
          )
        : (undefined as TQuery);
      const body = config.schema ? parseWith(config.schema, rawBody) : (rawBody as TBody);

      if (config.sharedSecret) verifySharedSecret(config.sharedSecret, request.headers);

      const params = await routeContext.params;
      const tenant = await resolveTenantContext({
        headerSlug: request.headers.get("x-tenant-slug"),
        host: request.headers.get("host") ?? request.nextUrl.host,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
          throw new HttpError("NOT_FOUND", {
            message: "This salon could not be found.",
            logMessage: "tenant slug did not resolve",
          });
        }
        throw error;
      });

      const result = await runWithTenantAsync(tenant, async () =>
        handler({
          req: request,
          body,
          query,
          params,
          ctx: routeContext,
          searchParams,
          requestId,
          clientIp: resolvedClientIp,
          rateLimit,
          log,
        }),
      );

      const response = toResponse(result, config.successStatus ?? 200);
      return finish(response, response.status);
    } catch (error) {
      const serialized = serializeError(error, requestId);
      const response = NextResponse.json(serialized.body, { status: serialized.status });
      return finish(response, serialized.status, {
        errorCode: serialized.code,
        error: serialized.logMessage,
        ...(serialized.stack ? { stack: serialized.stack } : {}),
      });
    }
  };
}
