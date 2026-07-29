export type PublicRuntimeConfig = {
  gcpEnabled: boolean;
  identityPlatformEnabled: boolean;
  paymentsMockEnabled: boolean;
  googlePayConfigured: boolean;
  environment: string;
};

/**
 * Kept in step with PLACEHOLDER_VALUES in packages/core/src/payment-service.ts on purpose:
 * this module is the public runtime config and must stay free of the Prisma client that
 * importing @hair-simo/core would drag in.
 */
const GOOGLE_PAY_ENV_VARS = [
  "GCP_GOOGLE_PAY_MERCHANT_ID",
  "GCP_PAYMENT_GATEWAY",
  "GCP_PAYMENT_GATEWAY_MERCHANT_ID",
] as const;

const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "bcr2dn4twoz7xxxx",
  "examplegatewaymerchantid",
  "examplemerchantid",
  "example",
  "changeme",
  "todo",
]);

const warned = new Set<string>();

export function resetPublicConfigWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(JSON.stringify({ severity: "WARNING", message, component: "public-config" }));
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function isPlaceholder(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") return true;
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  return normalized.includes("xxxx") || normalized.startsWith("example");
}

/**
 * Mock payments confirm real appointments without money moving, so production is not a
 * place where an environment variable may switch them back on. `PAYMENTS_MOCK_ENABLED`
 * only decides whether they are available OUTSIDE production.
 */
export function isPaymentsMockAllowed(): boolean {
  if (isProductionRuntime()) {
    if (process.env.PAYMENTS_MOCK_ENABLED === "true") {
      warnOnce(
        "mock-in-production",
        "PAYMENTS_MOCK_ENABLED=true is ignored in production; mock payments stay disabled.",
      );
    }
    return false;
  }
  return process.env.PAYMENTS_MOCK_ENABLED !== "false";
}

export function isGooglePayConfigured(): boolean {
  if (!process.env.GCP_PROJECT_ID) return false;
  return GOOGLE_PAY_ENV_VARS.every((name) => !isPlaceholder(process.env[name]));
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return {
    gcpEnabled: Boolean(process.env.GCP_PROJECT_ID),
    identityPlatformEnabled: process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true",
    paymentsMockEnabled: isPaymentsMockAllowed(),
    googlePayConfigured: isGooglePayConfigured(),
    environment: process.env.NODE_ENV ?? "development",
  };
}
