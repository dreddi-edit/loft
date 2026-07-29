import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./api-errors";

export type SharedSecretScheme = "bearer" | "raw";

export type SharedSecretDefinition = {
  envVars: readonly string[];
  header: string;
  scheme: SharedSecretScheme;
  /** Extra places the same secret may appear (Cloud Scheduler uses X-Cron-Secret while OIDC owns Authorization). */
  alternates?: readonly { header: string; scheme: SharedSecretScheme }[];
};

export const SHARED_SECRETS = {
  paymentWebhook: {
    envVars: ["GCP_PAYMENT_WEBHOOK_SECRET"],
    header: "authorization",
    scheme: "bearer",
  },
  cloudTasks: {
    envVars: ["GCP_CLOUD_TASKS_SECRET"],
    header: "authorization",
    scheme: "bearer",
  },
  cron: {
    envVars: ["GCP_CLOUD_TASKS_SECRET", "CRON_SECRET"],
    header: "x-cron-secret",
    scheme: "raw",
    alternates: [{ header: "authorization", scheme: "bearer" }],
  },
} as const satisfies Record<string, SharedSecretDefinition>;

export type SharedSecretName = keyof typeof SHARED_SECRETS;

export const SHARED_SECRET_NAMES = Object.keys(SHARED_SECRETS) as SharedSecretName[];

const RECOMMENDED_MIN_LENGTH = 32;

const warned = new Set<string>();

export function resetSharedSecretWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    JSON.stringify({ severity: "WARNING", message, component: "shared-secret", secret: key }),
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Returns the configured secret, or null when it is absent AND we are not in production.
 *
 * In production this throws, and callers are expected to invoke it at module/route init so
 * a misconfigured deployment fails at boot instead of silently serving an open endpoint.
 * The previous pattern (`if (expected && header !== ...) return 401`) made an unset
 * environment variable equivalent to "no authentication at all".
 */
export function requireSharedSecret(name: SharedSecretName): string | null {
  const definition = SHARED_SECRETS[name];
  let value: string | undefined;
  for (const envVar of definition.envVars) {
    const candidate = process.env[envVar];
    if (typeof candidate === "string" && candidate.length > 0) {
      value = candidate;
      break;
    }
  }

  if (value === undefined) {
    if (isProduction() && !isBuildPhase()) {
      throw new Error(
        `SHARED_SECRET_MISSING:${name}: set one of ${definition.envVars.join(", ")} before starting the service`,
      );
    }
    warnOnce(
      name,
      `Shared secret "${name}" is not configured (${definition.envVars.join(", ")}). The endpoint is UNAUTHENTICATED. This is refused in production.`,
    );
    return null;
  }

  if (isProduction() && value.length < RECOMMENDED_MIN_LENGTH) {
    warnOnce(
      `${name}:length`,
      `Shared secret "${name}" is shorter than ${RECOMMENDED_MIN_LENGTH} characters.`,
    );
  }

  return value;
}

export function timingSafeCompare(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function readSecretFromHeader(
  headers: Headers,
  header: string,
  scheme: SharedSecretScheme,
): string | null {
  const raw = headers.get(header);
  if (!raw) return null;
  if (scheme === "raw") return raw.trim() === "" ? null : raw.trim();
  const match = /^bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === "" ? null : token;
}

export function extractPresentedSecret(
  headers: Headers,
  definition: SharedSecretDefinition,
): string | null {
  const primary = readSecretFromHeader(headers, definition.header, definition.scheme);
  if (primary !== null) return primary;
  for (const alternate of definition.alternates ?? []) {
    const value = readSecretFromHeader(headers, alternate.header, alternate.scheme);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Throws HttpError("UNAUTHORIZED") unless the request presents the configured secret.
 * Absence of the secret is only tolerated outside production, and only loudly.
 */
export function verifySharedSecret(name: SharedSecretName, headers: Headers): void {
  const definition = SHARED_SECRETS[name];
  const expected = requireSharedSecret(name);
  const presented = extractPresentedSecret(headers, definition);

  if (expected === null) {
    warnOnce(
      `${name}:bypass`,
      `Accepting an unauthenticated request for "${name}" because no secret is configured (development only).`,
    );
    return;
  }

  if (presented === null || !timingSafeCompare(presented, expected)) {
    throw new HttpError("UNAUTHORIZED", {
      logMessage: `shared secret "${name}" ${presented === null ? "missing" : "mismatch"}`,
    });
  }
}

export function assertSharedSecretsConfigured(
  names: readonly SharedSecretName[] = SHARED_SECRET_NAMES,
): void {
  for (const name of names) requireSharedSecret(name);
}
