export type PublicRuntimeConfig = {
  gcpEnabled: boolean;
  identityPlatformEnabled: boolean;
  paymentsMockEnabled: boolean;
  googlePayConfigured: boolean;
  environment: string;
};

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  const gcpEnabled = Boolean(process.env.GCP_PROJECT_ID);
  const googlePayMerchantId = process.env.GCP_GOOGLE_PAY_MERCHANT_ID;
  const isProduction = process.env.NODE_ENV === "production";

  return {
    gcpEnabled,
    identityPlatformEnabled: process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true",
    paymentsMockEnabled:
      process.env.PAYMENTS_MOCK_ENABLED === "true" ||
      (!isProduction && process.env.PAYMENTS_MOCK_ENABLED !== "false"),
    googlePayConfigured: gcpEnabled && Boolean(googlePayMerchantId && !googlePayMerchantId.includes("XXXX")),
    environment: process.env.NODE_ENV ?? "development",
  };
}

export function isPaymentsMockAllowed(): boolean {
  return getPublicRuntimeConfig().paymentsMockEnabled;
}
