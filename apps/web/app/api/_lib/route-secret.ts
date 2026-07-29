import { HttpError } from "../../../lib/api-errors";
import {
  extractPresentedSecret,
  timingSafeCompare,
  type SharedSecretDefinition,
} from "../../../lib/shared-secret";

/**
 * Route-local twin of apps/web/lib/shared-secret.ts for secrets that are not (yet) part of
 * the SHARED_SECRETS registry, so `apiRoute({ sharedSecret })` cannot reference them by
 * name. Same fail-closed contract: unset in production is a boot failure, never an open
 * endpoint. See contractsForOtherAgents — once `dialogflowWebhook` is registered in
 * SHARED_SECRETS this module disappears in favour of the config flag.
 */
export const DIALOGFLOW_WEBHOOK_SECRET: SharedSecretDefinition = {
  envVars: ["GCP_DIALOGFLOW_WEBHOOK_SECRET"],
  header: "x-dialogflow-webhook-secret",
  scheme: "raw",
};

const warned = new Set<string>();

export function resetRouteSecretWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    JSON.stringify({ severity: "WARNING", message, component: "route-secret", secret: key }),
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function requireRouteSecret(definition: SharedSecretDefinition): string | null {
  for (const envVar of definition.envVars) {
    const candidate = process.env[envVar];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  const name = definition.envVars.join(", ");
  if (isProduction() && !isBuildPhase()) {
    throw new Error(`SHARED_SECRET_MISSING:${name}: set it before starting the service`);
  }
  warnOnce(
    name,
    `Route secret "${name}" is not configured. The endpoint is UNAUTHENTICATED. This is refused in production.`,
  );
  return null;
}

export function verifyRouteSecret(definition: SharedSecretDefinition, headers: Headers): void {
  const expected = requireRouteSecret(definition);
  const presented = extractPresentedSecret(headers, definition);
  const name = definition.envVars.join(", ");

  if (expected === null) {
    warnOnce(
      `${name}:bypass`,
      `Accepting an unauthenticated request for "${name}" because no secret is configured (development only).`,
    );
    return;
  }

  if (presented === null || !timingSafeCompare(presented, expected)) {
    throw new HttpError("UNAUTHORIZED", {
      logMessage: `route secret "${name}" ${presented === null ? "missing" : "mismatch"}`,
    });
  }
}
