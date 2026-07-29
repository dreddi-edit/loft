import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./api-errors";
import {
  SHARED_SECRETS,
  assertSharedSecretsConfigured,
  extractPresentedSecret,
  requireSharedSecret,
  resetSharedSecretWarnings,
  timingSafeCompare,
  verifySharedSecret,
} from "./shared-secret";

const SECRET = "b3f0d0e0c9a84a1fb2c1e5d9a7f4c2b6d8e0f1a3";

function bearer(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

beforeEach(() => {
  resetSharedSecretWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("requireSharedSecret", () => {
  it("returns the configured value", () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", SECRET);
    expect(requireSharedSecret("paymentWebhook")).toBe(SECRET);
  });

  it("falls back through the candidate environment variables in order", () => {
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", undefined);
    vi.stubEnv("CRON_SECRET", "cron-only");
    expect(requireSharedSecret("cron")).toBe("cron-only");
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "tasks-wins");
    expect(requireSharedSecret("cron")).toBe("tasks-wins");
  });

  it("throws in production when the secret is unset so the service fails at boot", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(() => requireSharedSecret("paymentWebhook")).toThrow(
      /SHARED_SECRET_MISSING:paymentWebhook/,
    );
  });

  it("does not break a production build when the secret is only injected at runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(requireSharedSecret("paymentWebhook")).toBeNull();
  });

  it("permits absence outside production but warns exactly once", () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(requireSharedSecret("paymentWebhook")).toBeNull();
    expect(requireSharedSecret("paymentWebhook")).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("UNAUTHENTICATED");
  });

  it("warns about short secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", "short");
    expect(requireSharedSecret("paymentWebhook")).toBe("short");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("checks every registered secret at once", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", undefined);
    vi.stubEnv("CRON_SECRET", undefined);
    expect(() => assertSharedSecretsConfigured()).toThrow(/SHARED_SECRET_MISSING:cloudTasks/);
  });
});

describe("timingSafeCompare", () => {
  it("compares equal and unequal values of any length", () => {
    expect(timingSafeCompare(SECRET, SECRET)).toBe(true);
    expect(timingSafeCompare(SECRET, `${SECRET}x`)).toBe(false);
    expect(timingSafeCompare("a", "abcdefghijklmnop")).toBe(false);
    expect(timingSafeCompare("", "")).toBe(true);
    expect(timingSafeCompare("ünïcödé", "ünïcödé")).toBe(true);
  });
});

describe("extractPresentedSecret", () => {
  it("parses the bearer scheme case-insensitively", () => {
    const definition = SHARED_SECRETS.paymentWebhook;
    expect(extractPresentedSecret(bearer(SECRET), definition)).toBe(SECRET);
    expect(
      extractPresentedSecret(new Headers({ authorization: `bearer ${SECRET}` }), definition),
    ).toBe(SECRET);
    expect(extractPresentedSecret(new Headers({ authorization: SECRET }), definition)).toBeNull();
    expect(
      extractPresentedSecret(new Headers({ authorization: "Bearer " }), definition),
    ).toBeNull();
    expect(extractPresentedSecret(new Headers({}), definition)).toBeNull();
  });
});

describe("verifySharedSecret", () => {
  it("accepts the matching secret", () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", SECRET);
    expect(() => verifySharedSecret("paymentWebhook", bearer(SECRET))).not.toThrow();
  });

  it("rejects a wrong or missing credential with UNAUTHORIZED", () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", SECRET);
    for (const headers of [
      bearer("wrong"),
      new Headers({}),
      new Headers({ authorization: SECRET }),
    ]) {
      let thrown: unknown;
      try {
        verifySharedSecret("paymentWebhook", headers);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).code).toBe("UNAUTHORIZED");
      expect((thrown as HttpError).status).toBe(401);
    }
  });

  it("fails closed in production when the secret is unset instead of accepting anything", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(() => verifySharedSecret("paymentWebhook", new Headers({}))).toThrow(
      /SHARED_SECRET_MISSING/,
    );
    expect(() => verifySharedSecret("paymentWebhook", bearer("anything"))).toThrow(
      /SHARED_SECRET_MISSING/,
    );
  });

  it("only bypasses authentication outside production, and says so", () => {
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", undefined);
    expect(() => verifySharedSecret("paymentWebhook", new Headers({}))).not.toThrow();
    const messages = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("development only"))).toBe(true);
  });
});
