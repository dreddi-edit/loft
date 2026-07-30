import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { resetSharedSecretWarnings } from "../../../../lib/shared-secret";

const confirmPayment = vi.fn();
const markFailed = vi.fn();
const createRefund = vi.fn();

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  PaymentService: class {
    confirmPayment = confirmPayment;
    markFailed = markFailed;
  },
  RefundService: class {
    createRefund = createRefund;
  },
}));

const TRANSPORT_SECRET = "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b";
const SIGNING_SECRET = "sig_4f3e2d1c0b9a8f7e6d5c4b3a29180716";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const { POST } = await import("./route");

const SUCCEEDED = {
  paymentId: "pay_1",
  status: "succeeded",
  amountCents: 2_000,
  currency: "EUR",
  providerReference: "ch_123",
};

function webhookRequest(
  body: unknown,
  headers: Record<string, string> = {},
  options: { raw?: string } = {},
): NextRequest {
  return new NextRequest("https://hairsimo.it/api/payments/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      authorization: `Bearer ${TRANSPORT_SECRET}`,
      ...headers,
    },
    body: options.raw ?? JSON.stringify(body),
  });
}

function signedHeaders(raw: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", SIGNING_SECRET)
    .update(`${timestampSeconds}.${raw}`, "utf8")
    .digest("hex");
  return { "x-payment-signature": `t=${timestampSeconds},v1=${signature}` };
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  resetSharedSecretWarnings();
  confirmPayment.mockReset();
  markFailed.mockReset();
  createRefund.mockReset();
  confirmPayment.mockResolvedValue({
    payment: { id: "pay_1", status: "succeeded" },
    alreadyConfirmed: false,
  });
  markFailed.mockResolvedValue({ payment: { id: "pay_1", status: "failed" }, changed: true });
  createRefund.mockResolvedValue({
    refundedCents: 2_000,
    remainingCents: 0,
    alreadyRefunded: false,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", TRANSPORT_SECRET);
  vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", "");
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/payments/webhook transport secret", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await POST(webhookRequest(SUCCEEDED, { authorization: "" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: safeMessageForCode("UNAUTHORIZED"),
    });
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    const response = await POST(webhookRequest(SUCCEEDED, { authorization: "Bearer nope" }));
    expect(response.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("accepts the configured bearer token", async () => {
    const response = await POST(webhookRequest(SUCCEEDED));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      received: true,
      data: { paymentId: "pay_1", status: "succeeded", replay: false },
    });
  });

  it("is fail-closed: constructing the route in production without a secret throws", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_PAYMENT_WEBHOOK_SECRET", "");
    resetSharedSecretWarnings();

    await expect(import("./route")).rejects.toThrow(/SHARED_SECRET_MISSING:paymentWebhook/);
    vi.resetModules();
  });
});

describe("POST /api/payments/webhook body signature", () => {
  it("refuses a signature while no signing secret is configured, rather than ignoring it", async () => {
    const raw = JSON.stringify(SUCCEEDED);
    const response = await POST(
      webhookRequest(null, { "x-payment-signature": "t=1,v1=deadbeef" }, { raw }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("requires a signature once the signing secret exists", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const response = await POST(webhookRequest(SUCCEEDED));
    expect(response.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over a different body", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const signed = signedHeaders(JSON.stringify({ ...SUCCEEDED, amountCents: 1 }));
    const response = await POST(webhookRequest(SUCCEEDED, signed));
    expect(response.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong key", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const raw = JSON.stringify(SUCCEEDED);
    const timestamp = Math.floor(Date.now() / 1000);
    const forged = createHmac("sha256", "attacker").update(`${timestamp}.${raw}`).digest("hex");
    const response = await POST(
      webhookRequest(null, { "x-payment-signature": `t=${timestamp},v1=${forged}` }, { raw }),
    );
    expect(response.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects a replayed signature outside the tolerance window", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const raw = JSON.stringify(SUCCEEDED);
    const stale = Math.floor(Date.now() / 1000) - 3_600;
    const response = await POST(webhookRequest(null, signedHeaders(raw, stale), { raw }));
    expect(response.status).toBe(401);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("accepts a signature over the exact bytes that were received", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const raw = JSON.stringify(SUCCEEDED);
    const response = await POST(webhookRequest(null, signedHeaders(raw), { raw }));
    expect(response.status).toBe(200);
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed signature header", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const response = await POST(webhookRequest(SUCCEEDED, { "x-payment-signature": "garbage" }));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/payments/webhook payload handling", () => {
  it("derives an idempotency key from the event id when the provider sends one", async () => {
    await POST(webhookRequest({ ...SUCCEEDED, eventId: "evt_abc" }));
    expect(confirmPayment.mock.calls[0][0]).toMatchObject({ idempotencyKey: "evt_evt_abc" });
  });

  it("falls back to the natural key of the logical event", async () => {
    await POST(webhookRequest(SUCCEEDED));
    expect(confirmPayment.mock.calls[0][0]).toMatchObject({
      idempotencyKey: "evt_pay_1_succeeded_2000",
    });
  });

  it("refuses a success event that does not state the captured amount", async () => {
    const response = await POST(
      webhookRequest({ paymentId: "pay_1", status: "succeeded", providerReference: "ch_1" }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path),
    ).toContain("amountCents");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("refuses a success event with no provider evidence at all", async () => {
    const response = await POST(
      webhookRequest({ paymentId: "pay_1", status: "succeeded", amountCents: 2_000 }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path),
    ).toContain("providerReference");
  });

  it("rejects an unknown status and an unbounded provider token", async () => {
    const badStatus = await POST(webhookRequest({ paymentId: "pay_1", status: "disputed" }));
    expect(badStatus.status).toBe(400);

    const wideToken = await POST(
      webhookRequest({ ...SUCCEEDED, googlePayToken: "t".repeat(8_193) }),
    );
    expect([400, 413]).toContain(wideToken.status);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body before it is parsed or verified", async () => {
    const response = await POST(webhookRequest({ ...SUCCEEDED, padding: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("routes a failure event and a refund event to their own service", async () => {
    const failed = await POST(webhookRequest({ paymentId: "pay_1", status: "failed" }));
    expect(failed.status).toBe(200);
    expect(markFailed).toHaveBeenCalledTimes(1);

    const refunded = await POST(
      webhookRequest({ paymentId: "pay_1", status: "refunded", amountCents: 2_000 }),
    );
    expect(refunded.status).toBe(200);
    expect(createRefund.mock.calls[0][0]).toMatchObject({ origin: "provider" });
  });

  it("returns 400 for an empty body rather than treating it as a confirmed payment", async () => {
    const response = await POST(webhookRequest(null, {}, { raw: "" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  /**
   * Characterisation, not an endorsement: the exported POST re-wraps the request outside
   * its try block, so a non-POST invocation escapes as a raw TypeError instead of a
   * taxonomy response. Next only routes POST here, so it is unreachable through the
   * router — see openIssues before relying on the inner `methods: ["POST"]` guard.
   */
  it("has no working method guard of its own", async () => {
    await expect(
      POST(
        new NextRequest("https://hairsimo.it/api/payments/webhook", {
          method: "GET",
          headers: { authorization: `Bearer ${TRANSPORT_SECRET}` },
        }),
      ),
    ).rejects.toThrow(/GET\/HEAD method cannot have body/);
  });

  it("returns 429 with Retry-After once the payment policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.payment);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(webhookRequest(SUCCEEDED))).status).toBe(200);
    }
    const blocked = await POST(webhookRequest(SUCCEEDED));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("POST /api/payments/webhook error shape", () => {
  it("maps the money-safety refusals onto the taxonomy", async () => {
    confirmPayment.mockRejectedValue(new Error("PAYMENT_AMOUNT_MISMATCH:2000 vs 100"));
    const mismatch = await POST(webhookRequest(SUCCEEDED));
    expect(mismatch.status).toBe(402);
    expect(await mismatch.json()).toMatchObject({
      error: "PAYMENT_FAILED",
      message: "The captured amount does not match the amount that was owed.",
    });

    confirmPayment.mockRejectedValue(new Error("IDEMPOTENCY_KEY_REUSED"));
    const reused = await POST(webhookRequest(SUCCEEDED));
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe("CONFLICT");

    confirmPayment.mockRejectedValue(new Error("PAYMENT_NOT_FOUND"));
    const missing = await POST(webhookRequest(SUCCEEDED));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("PAYMENT_NOT_FOUND");
  });

  it("never leaks the payment provider failure to the client", async () => {
    confirmPayment.mockRejectedValue(
      new Error(
        "Invalid `prisma.payment.update()` invocation in /app/packages/db/src/client.ts:33 " +
          "Unique constraint failed on the fields: (`idempotencyKey`)",
      ),
    );

    const response = await POST(webhookRequest(SUCCEEDED));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error).toBe("INTERNAL");
    expect(body.message).toBe(safeMessageForCode("INTERNAL"));
    expect(typeof body.requestId).toBe("string");
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Unique constraint");
    expect(encoded).not.toContain("/app/packages");
  });

  it("never echoes the transport secret or the signature back to the caller", async () => {
    vi.stubEnv("PAYMENT_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
    const response = await POST(webhookRequest(SUCCEEDED));
    const encoded = JSON.stringify(await response.json());
    expect(encoded).not.toContain(TRANSPORT_SECRET);
    expect(encoded).not.toContain(SIGNING_SECRET);
    expect(encoded).not.toContain("PAYMENT_WEBHOOK_SIGNING_SECRET");
  });
});
