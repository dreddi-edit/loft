import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { GET } from "./route";

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const SECRET_ENV_VARS = [
  "GCP_PAYMENT_WEBHOOK_SECRET",
  "GCP_CLOUD_TASKS_SECRET",
  "GCP_DIALOGFLOW_WEBHOOK_SECRET",
  "APPOINTMENT_TOKEN_SECRET",
  "ADMIN_JWT_SECRET",
  "DATABASE_URL",
] as const;

function request(): NextRequest {
  return new NextRequest("https://hairsimo.it/api/config/public", {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/config/public", () => {
  it("returns only booleans and the environment name", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.data).sort()).toEqual([
      "environment",
      "gcpEnabled",
      "googlePayConfigured",
      "identityPlatformEnabled",
      "paymentsMockEnabled",
    ]);
    expect(typeof body.data.environment).toBe("string");
    for (const key of Object.keys(body.data)) {
      if (key === "environment") continue;
      expect(typeof body.data[key], key).toBe("boolean");
    }
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never echoes a secret value even when every secret is configured", async () => {
    for (const name of SECRET_ENV_VARS) {
      vi.stubEnv(name, `sentinel-${name.toLowerCase()}-value`);
    }
    vi.stubEnv("GCP_PROJECT_ID", "hair-simo-prod");
    vi.stubEnv("GCP_GOOGLE_PAY_MERCHANT_ID", "real-merchant-id");

    const encoded = JSON.stringify(await (await GET(request())).json());
    expect(encoded).not.toContain("sentinel-");
    expect(encoded).not.toContain("real-merchant-id");
    expect(encoded).not.toContain("hair-simo-prod");
  });

  it("reports mock payments as disabled in production regardless of the flag", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENTS_MOCK_ENABLED", "true");
    const body = await (await GET(request())).json();
    expect(body.data.paymentsMockEnabled).toBe(false);
  });

  it("rejects a write method with 405", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/config/public", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the publicRead policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.publicRead);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await GET(request())).status).toBe(200);
    }
    const blocked = await GET(request());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });
});
