import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { AuthSession } from "@hair-simo/core";
import { salonRepository } from "@hair-simo/core";
import { prisma, runWithTenantAsync, type RoleKey } from "@hair-simo/db";
import { ZodError, z, type ZodType } from "zod";
import { requireSession } from "./auth";
import { extractClientIp } from "./login-throttle";

function tenantContextFromSession(session: AuthSession) {
  return { tenantId: session.tenantId, slug: session.tenantSlug };
}

export const REQUEST_ID_HEADER = "x-request-id";
export const DEFAULT_BODY_LIMIT_BYTES = 65_536;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_OFFSET = 100_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/* -------------------------------------------------------------------------- */
/* Error taxonomy — mirrors apps/web/lib/api-errors.ts                          */
/* -------------------------------------------------------------------------- */

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "SLOT_NOT_AVAILABLE",
  "SERVICE_NOT_FOUND",
  "STAFF_NOT_ELIGIBLE",
  "APPOINTMENT_NOT_FOUND",
  "PAYMENT_NOT_FOUND",
  "PAYMENT_FAILED",
  "INSUFFICIENT_STOCK",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  SLOT_NOT_AVAILABLE: 409,
  SERVICE_NOT_FOUND: 404,
  STAFF_NOT_ELIGIBLE: 409,
  APPOINTMENT_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  PAYMENT_FAILED: 402,
  INSUFFICIENT_STOCK: 409,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "The request payload is invalid.",
  UNAUTHORIZED: "Sign in again to continue.",
  FORBIDDEN: "Your role is not allowed to perform this action.",
  NOT_FOUND: "The requested record does not exist.",
  METHOD_NOT_ALLOWED: "This HTTP method is not supported for this endpoint.",
  CONFLICT: "The request conflicts with the current state of the record.",
  PAYLOAD_TOO_LARGE: "The request payload exceeds the allowed size.",
  UNSUPPORTED_MEDIA_TYPE: "The request content type is not supported.",
  RATE_LIMITED: "Too many requests. Please slow down and try again shortly.",
  SLOT_NOT_AVAILABLE: "The selected time slot is no longer available.",
  SERVICE_NOT_FOUND: "The requested service does not exist.",
  STAFF_NOT_ELIGIBLE: "The selected team member cannot perform this service.",
  APPOINTMENT_NOT_FOUND: "The requested appointment does not exist.",
  PAYMENT_NOT_FOUND: "The requested payment does not exist.",
  PAYMENT_FAILED: "The payment could not be processed.",
  INSUFFICIENT_STOCK: "There is not enough stock for this movement.",
  UPSTREAM_UNAVAILABLE: "A downstream service is temporarily unavailable.",
  INTERNAL: "An unexpected error occurred. Please try again later.",
};

/**
 * Raw error strings thrown by packages/core, mapped onto the taxonomy. Anything absent is
 * deliberately reported as INTERNAL so Prisma constraint names, file paths and
 * configuration failures such as ADMIN_JWT_SECRET_MISSING never reach the browser.
 */
const ERROR_CODE_ALIASES: Record<string, ErrorCode> = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  INVALID_TOKEN: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  USER_NOT_FOUND: "UNAUTHORIZED",
  TOKEN_VERSION_MISMATCH: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  SLOT_NOT_AVAILABLE: "SLOT_NOT_AVAILABLE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  STAFF_NOT_ELIGIBLE: "STAFF_NOT_ELIGIBLE",
  STAFF_NOT_FOUND: "NOT_FOUND",
  CUSTOMER_NOT_FOUND: "NOT_FOUND",
  NOTE_NOT_FOUND: "NOT_FOUND",
  ALLERGY_NOTE_MUST_STAY_PINNED: "CONFLICT",
  ALLERGY_NOTE_DELETE_NOT_CONFIRMED: "CONFLICT",
  PRODUCT_NOT_FOUND: "NOT_FOUND",
  TIME_OFF_NOT_FOUND: "NOT_FOUND",
  APPOINTMENT_NOT_FOUND: "APPOINTMENT_NOT_FOUND",
  NOTIFICATION_NOT_FOUND: "NOT_FOUND",
  NOTIFICATION_PAYLOAD_INVALID: "VALIDATION_ERROR",
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  PAYMENT_INTENT_MISSING: "PAYMENT_FAILED",
  PAYMENT_NOT_REFUNDABLE: "CONFLICT",
  INVALID_REFUND_AMOUNT: "VALIDATION_ERROR",
  INVALID_TIME_RANGE: "VALIDATION_ERROR",
  INVALID_DATE_RANGE: "VALIDATION_ERROR",
  INVALID_DAY: "VALIDATION_ERROR",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  VERTEX_REQUEST_FAILED: "UPSTREAM_UNAVAILABLE",
  PUBSUB_FAILED: "UPSTREAM_UNAVAILABLE",
};

/**
 * Prisma reports failures as short codes and puts the offending table, column and unique
 * index name in `message`. Only the code is consulted; the message stays server side.
 */
const PRISMA_CODE_ALIASES: Record<string, ErrorCode> = {
  P2002: "CONFLICT",
  P2003: "CONFLICT",
  P2014: "CONFLICT",
  P2025: "NOT_FOUND",
  P2034: "CONFLICT",
};

const MAX_DETAILS = 20;
const MAX_DETAIL_MESSAGE_LENGTH = 200;

export type ErrorDetail = { path: string; code: string; message: string };

export type ErrorResponseBody = {
  error: ErrorCode;
  message: string;
  requestId: string;
  details?: ErrorDetail[];
};

export type HttpErrorOptions = {
  status?: number;
  message?: string;
  details?: ErrorDetail[];
  cause?: unknown;
  logMessage?: string;
};

export function statusForCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function safeMessageForCode(code: ErrorCode): string {
  return SAFE_MESSAGES[code];
}

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly safeMessage: string;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, options: HttpErrorOptions = {}) {
    super(options.logMessage ?? options.message ?? code, { cause: options.cause });
    this.name = "HttpError";
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.safeMessage = options.message ?? safeMessageForCode(code);
    this.details = options.details;
  }
}

export function httpError(code: ErrorCode, options: HttpErrorOptions = {}): HttpError {
  return new HttpError(code, options);
}

function truncate(value: string, max = MAX_DETAIL_MESSAGE_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.slice(0, MAX_DETAILS).map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join(".") || "(root)",
    code: issue.code,
    message: truncate(issue.message),
  }));
}

export function validationErrorFromZod(error: ZodError, message?: string): HttpError {
  return new HttpError("VALIDATION_ERROR", {
    message: message ?? safeMessageForCode("VALIDATION_ERROR"),
    details: zodIssuesToDetails(error),
    cause: error,
    logMessage: `validation failed with ${error.issues.length} issue(s)`,
  });
}

function prismaCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined;
}

export function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) return validationErrorFromZod(error);
  const prismaCode = prismaCodeOf(error);
  if (prismaCode) {
    return new HttpError(PRISMA_CODE_ALIASES[prismaCode] ?? "INTERNAL", {
      cause: error,
      logMessage: `prisma ${prismaCode}`,
    });
  }
  if (error instanceof Error) {
    const alias = ERROR_CODE_ALIASES[error.message.split(":", 1)[0].trim()];
    return new HttpError(alias ?? "INTERNAL", { cause: error, logMessage: error.message });
  }
  return new HttpError("INTERNAL", { logMessage: `non-error thrown: ${String(error)}` });
}

export type SerializedError = {
  status: number;
  body: ErrorResponseBody;
  code: ErrorCode;
  logMessage: string;
  stack?: string;
};

/**
 * Produces the client payload and the server-side log payload from any thrown value. The
 * client never receives `error.message`; only the static safe message for the mapped code
 * plus the request id, so the salon can quote it and support can find the log line.
 */
export function serializeError(error: unknown, requestId: string): SerializedError {
  const normalized = normalizeError(error);
  const cause = normalized.cause;
  const body: ErrorResponseBody = {
    error: normalized.code,
    message: normalized.safeMessage,
    requestId,
  };
  if (normalized.details && normalized.details.length > 0) body.details = normalized.details;
  return {
    status: normalized.status,
    body,
    code: normalized.code,
    logMessage: `${normalized.message}${cause instanceof Error ? `: ${cause.message}` : ""}`,
    stack: cause instanceof Error ? cause.stack : normalized.stack,
  };
}

/* -------------------------------------------------------------------------- */
/* Structured logging                                                          */
/* -------------------------------------------------------------------------- */

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

export function setAdminApiLogSink(sink: LogSink): void {
  activeSink = sink;
}

export function resetAdminApiLogSink(): void {
  activeSink = defaultSink;
}

export type ApiLogger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

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

function severityForStatus(status: number): LogSeverity {
  if (status >= 500) return "ERROR";
  if (status >= 400) return "WARNING";
  return "INFO";
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

export type RateLimitPolicy = { limit: number; windowMs: number; burst?: number };

export type AdminRateLimitPolicyName = "adminIp" | "adminRead" | "adminMutation" | "adminSensitive";

/**
 * Sized for four operators sharing one backoffice, not for a public API. An operator
 * clicking through the calendar never comes close; a stolen session trying to enumerate
 * customers or mass-cancel appointments hits the ceiling within seconds.
 * `adminIp` is the pre-authentication guard that bounds how often an unverified caller can
 * make the wrapper do the session lookup, which reads the user row on every request.
 */
export const ADMIN_RATE_LIMIT_POLICIES: Record<AdminRateLimitPolicyName, RateLimitPolicy> = {
  adminIp: { limit: 300, windowMs: 60_000, burst: 120 },
  adminRead: { limit: 240, windowMs: 60_000, burst: 60 },
  adminMutation: { limit: 60, windowMs: 60_000, burst: 30 },
  adminSensitive: { limit: 10, windowMs: 300_000, burst: 5 },
};

export type RateLimitResult = {
  allowed: boolean;
  policy: AdminRateLimitPolicyName;
  key: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type RateLimitEntry = { count: number; resetAt: number };

const MAX_RATE_LIMIT_BUCKETS = 5_000;
const buckets = new Map<string, RateLimitEntry>();

function pruneBuckets(now: number): void {
  if (buckets.size <= MAX_RATE_LIMIT_BUCKETS) return;
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_RATE_LIMIT_BUCKETS) break;
    buckets.delete(key);
  }
}

export function enforceAdminRateLimit(
  policy: AdminRateLimitPolicyName,
  identifier: string,
  now: number = Date.now(),
): RateLimitResult {
  const definition = ADMIN_RATE_LIMIT_POLICIES[policy];
  const ceiling = definition.limit + (definition.burst ?? 0);
  const key = `${policy}:${identifier}`;
  const existing = buckets.get(key);
  const entry =
    !existing || existing.resetAt <= now
      ? { count: 1, resetAt: now + definition.windowMs }
      : { count: existing.count + 1, resetAt: existing.resetAt };
  buckets.set(key, entry);
  pruneBuckets(now);
  const allowed = entry.count <= ceiling;
  return {
    allowed,
    policy,
    key,
    limit: ceiling,
    used: entry.count,
    remaining: Math.max(0, ceiling - entry.count),
    resetAt: entry.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

export function resetAdminRateLimits(): void {
  buckets.clear();
}

function rateLimitHeaders(result: RateLimitResult, now: number): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((result.resetAt - now) / 1000))),
    "RateLimit-Policy": `${result.limit};w=${Math.round(
      ADMIN_RATE_LIMIT_POLICIES[result.policy].windowMs / 1000,
    )}`,
  };
  if (!result.allowed) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                 */
/* -------------------------------------------------------------------------- */

export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

export type AuditEntry = {
  actorId?: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: AuditJsonValue;
  after?: AuditJsonValue;
  ip?: string;
  userAgent?: string;
};

export type AuditWriter = (entry: AuditEntry) => Promise<unknown>;

const defaultAuditWriter: AuditWriter = (entry) => salonRepository.createAuditLog(entry);

let activeAuditWriter: AuditWriter = defaultAuditWriter;

export function setAdminAuditWriter(writer: AuditWriter): void {
  activeAuditWriter = writer;
}

export function resetAdminAuditWriter(): void {
  activeAuditWriter = defaultAuditWriter;
}

/**
 * Key fragments that must never reach the audit table. Matched against the key with every
 * non-alphanumeric character removed, so `password_hash`, `newPassword` and `id-token` all
 * collapse onto the same fragment.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "passphrase",
  "token",
  "secret",
  "credential",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "cardnumber",
  "cvv",
  "cvc",
  "iban",
  "bic",
];

const REDACTED = "[redacted]";
const MAX_AUDIT_DEPTH = 6;
const MAX_AUDIT_ARRAY = 50;
const MAX_AUDIT_STRING = 500;
const MAX_AUDIT_JSON_BYTES = 8_000;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function toAuditJson(value: unknown, depth = 0): AuditJsonValue | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncate(value, MAX_AUDIT_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_AUDIT_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    const items: AuditJsonValue[] = [];
    for (const item of value.slice(0, MAX_AUDIT_ARRAY)) {
      const converted = toAuditJson(item, depth + 1);
      if (converted !== undefined) items.push(converted);
    }
    if (value.length > MAX_AUDIT_ARRAY) items.push("[truncated]");
    return items;
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: { [key: string]: AuditJsonValue } = {};
    for (const key of Object.keys(source)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const converted = toAuditJson(source[key], depth + 1);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }

  return undefined;
}

/**
 * Never log a password, a session token or a payment instrument. Values are converted to
 * plain JSON, keys that look like a secret are replaced wholesale, and the result is capped
 * so a bulk payload cannot bloat the audit table.
 */
export function redactForAudit(value: unknown): AuditJsonValue | undefined {
  const converted = toAuditJson(value);
  if (converted === undefined) return undefined;
  const encoded = JSON.stringify(converted);
  if (encoded !== undefined && encoded.length > MAX_AUDIT_JSON_BYTES) {
    return { truncated: true, bytes: encoded.length };
  }
  return converted;
}

export type AuditRecorder = {
  setAction(action: string): void;
  setEntity(entityType: string, entityId?: string): void;
  setEntityId(entityId: string): void;
  setBefore(value: unknown): void;
  setAfter(value: unknown): void;
};

type AuditState = {
  entityType: string;
  entityId: string;
  action: string;
  before?: AuditJsonValue;
  after?: AuditJsonValue;
  afterExplicit: boolean;
};

/**
 * Populates `AppointmentStatusHistory.changedBy`, which the booking service leaves null
 * because it has no notion of an operator. The newest unattributed row for the appointment
 * is the one the request just created.
 */
export async function recordStatusHistoryActor(
  appointmentId: string,
  session: AuthSession,
  log?: ApiLogger,
): Promise<void> {
  try {
    const latest = await prisma.appointmentStatusHistory.findFirst({
      where: { appointmentId, changedBy: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!latest) return;
    await prisma.appointmentStatusHistory.update({
      where: { id: latest.id },
      data: { changedBy: session.userId },
    });
  } catch (error) {
    log?.error("status history attribution failed", {
      appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export const paginationShape = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
};

export const paginationSchema = z.object(paginationShape).strict();

export type PageInput = { limit: number; offset: number };

export type PaginationEnvelope = {
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
};

/**
 * Keeps the historical `{ data }` envelope so existing consumers are unaffected, and adds a
 * sibling `pagination` block. `hasMore` is derived from a full page being returned rather
 * than a second count query — good enough for a backoffice list and free.
 */
export function paginated<T>(items: T[], page: PageInput): { data: T[]; pagination: PaginationEnvelope } {
  return {
    data: items,
    pagination: {
      limit: page.limit,
      offset: page.offset,
      count: items.length,
      hasMore: items.length === page.limit,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Route wrapper                                                               */
/* -------------------------------------------------------------------------- */

export type RouteParams = Record<string, string | string[]>;
export type RouteContext<TParams extends RouteParams = RouteParams> = { params: Promise<TParams> };

export type AdminAuditConfig<TBody, TParams extends RouteParams> = {
  entityType: string;
  action?: string;
  entityId?: (params: TParams, body: TBody) => string | undefined;
};

export type AdminRouteConfig<TBody, TQuery, TParams extends RouteParams> = {
  roles: readonly RoleKey[];
  route?: string;
  policy?: AdminRateLimitPolicyName;
  schema?: ZodType<TBody>;
  query?: ZodType<TQuery>;
  bodyLimitBytes?: number;
  successStatus?: number;
  audit?: AdminAuditConfig<TBody, TParams>;
};

export type AdminHandlerContext<TBody, TQuery, TParams extends RouteParams> = {
  req: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  searchParams: URLSearchParams;
  session: AuthSession;
  requestId: string;
  clientIp: string;
  audit: AuditRecorder;
  log: ApiLogger;
};

export type AdminHandlerResult = Response | Record<string, unknown> | readonly unknown[] | null;

export type AdminHandler<TBody, TQuery, TParams extends RouteParams> = (
  context: AdminHandlerContext<TBody, TQuery, TParams>,
) => Promise<AdminHandlerResult> | AdminHandlerResult;

export type AdminRouteHandler<TParams extends RouteParams> = (
  request: NextRequest,
  context?: RouteContext<TParams>,
) => Promise<Response>;

async function readBody(request: NextRequest, limitBytes: number): Promise<unknown> {
  if (METHODS_WITHOUT_BODY.has(request.method.toUpperCase())) return {};

  const contentType = request.headers.get("content-type") ?? "";
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limitBytes) {
      throw new HttpError("PAYLOAD_TOO_LARGE", {
        logMessage: `content-length ${size} exceeds limit ${limitBytes}`,
      });
    }
  }

  const raw = await request.text();
  if (raw.length > limitBytes) {
    throw new HttpError("PAYLOAD_TOO_LARGE", {
      logMessage: `body ${raw.length} exceeds limit ${limitBytes}`,
    });
  }
  if (raw.trim() === "") return {};

  if (!contentType.toLowerCase().includes("json")) {
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", {
      logMessage: `unsupported content-type "${contentType}"`,
    });
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError("VALIDATION_ERROR", {
      message: "Request body is not valid JSON.",
      logMessage: "json parse failed",
    });
  }
}

function parseWith<T>(schema: ZodType<T>, value: unknown, message?: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw validationErrorFromZod(parsed.error, message);
}

function toResponse(result: AdminHandlerResult, successStatus: number): Response {
  if (result instanceof Response) return result;
  return NextResponse.json(result ?? {}, { status: successStatus });
}

function defaultPolicyFor(method: string): AdminRateLimitPolicyName {
  return MUTATING_METHODS.has(method) ? "adminMutation" : "adminRead";
}

/**
 * Wraps a Next.js App Router admin handler with the shared request pipeline: trusted
 * client-IP extraction, a pre-authentication IP limiter, the session and role check, a
 * per-operator limiter, a body size cap, zod validation with field-level errors, an audit
 * row for every successful mutation, and error serialisation that never leaks
 * `error.message`.
 *
 * `roles` is required, so a route cannot be written without declaring who may call it.
 * The second argument keeps the Next 16 shape `{ params: Promise<Params> }`.
 */
export function adminRoute<
  TBody = unknown,
  TQuery = undefined,
  TParams extends RouteParams = RouteParams,
>(
  config: AdminRouteConfig<TBody, TQuery, TParams>,
  handler: AdminHandler<TBody, TQuery, TParams>,
): AdminRouteHandler<TParams> {
  if (!config.roles || config.roles.length === 0) {
    throw new Error("ADMIN_ROUTE_ROLES_REQUIRED");
  }

  return async (request, context) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const method = request.method.toUpperCase();
    const routeName = config.route ?? new URL(request.url).pathname;
    const mutating = MUTATING_METHODS.has(method);
    const policy = config.policy ?? defaultPolicyFor(method);
    const routeContext: RouteContext<TParams> = context ?? {
      params: Promise.resolve({} as TParams),
    };

    const log = createLogger({ requestId, route: routeName, method });

    let clientIp = "unknown";
    let rateLimit: RateLimitResult | null = null;
    let session: AuthSession | null = null;

    const finish = (response: Response, status: number, extra?: LogFields): Response => {
      const now = Date.now();
      response.headers.set(REQUEST_ID_HEADER, requestId);
      if (rateLimit) {
        for (const [key, value] of Object.entries(rateLimitHeaders(rateLimit, now))) {
          response.headers.set(key, value);
        }
      }
      activeSink({
        severity: severityForStatus(status),
        message: `${method} ${routeName} ${status}`,
        requestId,
        route: routeName,
        method,
        status,
        durationMs: now - startedAt,
        clientIp,
        ...(session ? { actorId: session.userId, actorRole: session.role } : {}),
        ...(rateLimit ? { policy: rateLimit.policy, rateLimitUsed: rateLimit.used } : {}),
        ...extra,
      });
      return response;
    };

    try {
      clientIp = extractClientIp(request.headers);

      const ipLimit = enforceAdminRateLimit("adminIp", `ip:${clientIp}`);
      rateLimit = ipLimit;
      if (!ipLimit.allowed) {
        throw new HttpError("RATE_LIMITED", { logMessage: `adminIp exceeded for ${clientIp}` });
      }

      session = await requireSession(request, config.roles as RoleKey[]);
      const resolvedSession = session;

      const actorLimit = enforceAdminRateLimit(policy, `user:${resolvedSession.userId}`);
      rateLimit = actorLimit;
      if (!actorLimit.allowed) {
        throw new HttpError("RATE_LIMITED", {
          logMessage: `${policy} exceeded for user ${resolvedSession.userId}`,
        });
      }

      const rawBody = await readBody(request, config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);
      const searchParams = request.nextUrl.searchParams;
      const query = config.query
        ? parseWith(
            config.query,
            Object.fromEntries(searchParams.entries()),
            "Invalid query parameters.",
          )
        : (undefined as TQuery);
      const body = config.schema ? parseWith(config.schema, rawBody) : (rawBody as TBody);
      const params = await routeContext.params;

      const auditState: AuditState = {
        entityType: config.audit?.entityType ?? routeName,
        entityId: config.audit?.entityId?.(params, body) ?? "-",
        action: config.audit?.action ?? `${method.toLowerCase()}.${config.audit?.entityType ?? routeName}`,
        afterExplicit: false,
      };

      const audit: AuditRecorder = {
        setAction: (action) => {
          auditState.action = action;
        },
        setEntity: (entityType, entityId) => {
          auditState.entityType = entityType;
          if (entityId) auditState.entityId = entityId;
        },
        setEntityId: (entityId) => {
          auditState.entityId = entityId;
        },
        setBefore: (value) => {
          auditState.before = redactForAudit(value);
        },
        setAfter: (value) => {
          auditState.after = redactForAudit(value);
          auditState.afterExplicit = true;
        },
      };

      const result = await runWithTenantAsync(tenantContextFromSession(resolvedSession), async () =>
        handler({
          req: request,
          body,
          query,
          params,
          searchParams,
          session: resolvedSession,
          requestId,
          clientIp,
          audit,
          log,
        }),
      );

      const response = toResponse(result, config.successStatus ?? 200);

      if (mutating) {
        if (!auditState.afterExplicit) auditState.after = redactForAudit(body);
        await writeAudit(auditState, session, request, clientIp, log);
      }

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

async function writeAudit(
  state: AuditState,
  session: AuthSession,
  request: NextRequest,
  clientIp: string,
  log: ApiLogger,
): Promise<void> {
  const userAgent = request.headers.get("user-agent");
  try {
    await activeAuditWriter({
      actorId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: state.action,
      entityType: state.entityType,
      entityId: state.entityId,
      ...(state.before === undefined ? {} : { before: state.before }),
      ...(state.after === undefined ? {} : { after: state.after }),
      ...(clientIp === "unknown" ? {} : { ip: clientIp }),
      ...(userAgent ? { userAgent: truncate(userAgent, 300) } : {}),
    });
  } catch (error) {
    // A broken audit sink must not undo a mutation the operator already committed, but it
    // has to be loud: this is the only record of who changed what.
    log.error("audit write failed", {
      action: state.action,
      entityType: state.entityType,
      entityId: state.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
