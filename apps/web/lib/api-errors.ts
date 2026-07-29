import { ZodError } from "zod";

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
  UNAUTHORIZED: "Authentication is required for this endpoint.",
  FORBIDDEN: "You are not allowed to perform this action.",
  NOT_FOUND: "The requested resource does not exist.",
  METHOD_NOT_ALLOWED: "This HTTP method is not supported for this endpoint.",
  CONFLICT: "The request conflicts with the current state of the resource.",
  PAYLOAD_TOO_LARGE: "The request payload exceeds the allowed size.",
  UNSUPPORTED_MEDIA_TYPE: "The request content type is not supported.",
  RATE_LIMITED: "Too many requests. Please slow down and try again later.",
  SLOT_NOT_AVAILABLE: "The selected time slot is no longer available.",
  SERVICE_NOT_FOUND: "The requested service does not exist.",
  STAFF_NOT_ELIGIBLE: "The selected stylist cannot perform this service.",
  APPOINTMENT_NOT_FOUND: "The requested appointment does not exist.",
  PAYMENT_NOT_FOUND: "The requested payment does not exist.",
  PAYMENT_FAILED: "The payment could not be processed.",
  INSUFFICIENT_STOCK: "The requested product is out of stock.",
  UPSTREAM_UNAVAILABLE: "A downstream service is temporarily unavailable.",
  INTERNAL: "An unexpected error occurred. Please try again later.",
};

/**
 * Raw error strings thrown by packages/core and packages/gcp, mapped onto the taxonomy.
 * Anything absent here is deliberately reported as INTERNAL so configuration failures
 * such as JWT_SECRET_MISSING never reach a client.
 */
const ERROR_CODE_ALIASES: Record<string, ErrorCode> = {
  SLOT_NOT_AVAILABLE: "SLOT_NOT_AVAILABLE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  STAFF_NOT_ELIGIBLE: "STAFF_NOT_ELIGIBLE",
  APPOINTMENT_NOT_FOUND: "APPOINTMENT_NOT_FOUND",
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  PAYMENT_INTENT_MISSING: "PAYMENT_FAILED",
  INVALID_REFUND_AMOUNT: "VALIDATION_ERROR",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  NOTIFICATION_NOT_FOUND: "NOT_FOUND",
  NOTIFICATION_PAYLOAD_INVALID: "VALIDATION_ERROR",
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  USER_NOT_FOUND: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TOKEN: "UNAUTHORIZED",
  VERTEX_REQUEST_FAILED: "UPSTREAM_UNAVAILABLE",
  PUBSUB_FAILED: "UPSTREAM_UNAVAILABLE",
};

const MAX_DETAILS = 20;
const MAX_DETAIL_MESSAGE_LENGTH = 200;

export type ErrorDetail = {
  path: string;
  code: string;
  message: string;
};

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

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
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

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_DETAIL_MESSAGE_LENGTH)}...`;
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

function aliasKeyFor(message: string): string {
  const head = message.split(":", 1)[0];
  return head.trim();
}

export function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) return validationErrorFromZod(error);
  if (error instanceof Error) {
    const alias = ERROR_CODE_ALIASES[aliasKeyFor(error.message)];
    return new HttpError(alias ?? "INTERNAL", { cause: error, logMessage: error.message });
  }
  return new HttpError("INTERNAL", { logMessage: `non-error thrown: ${String(error)}` });
}

export function toErrorResponseBody(error: HttpError, requestId: string): ErrorResponseBody {
  const body: ErrorResponseBody = {
    error: error.code,
    message: error.safeMessage,
    requestId,
  };
  if (error.details && error.details.length > 0) body.details = error.details;
  return body;
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
 * plus the request id, so support can correlate against the structured log line.
 */
export function serializeError(error: unknown, requestId: string): SerializedError {
  const normalized = normalizeError(error);
  const cause = normalized.cause;
  const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
  return {
    status: normalized.status,
    body: toErrorResponseBody(normalized, requestId),
    code: normalized.code,
    logMessage: `${normalized.message}${causeMessage}`,
    stack: cause instanceof Error ? cause.stack : normalized.stack,
  };
}
