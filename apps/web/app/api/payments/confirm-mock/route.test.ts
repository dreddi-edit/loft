import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { resetPublicConfigWarnings } from "../../../../lib/public-config";

const confirmPayment = vi.fn();

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
  },
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/payments/confirm-mock", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  resetPublicConfigWarnings();
  confirmPayment.mockReset();
  confirmPayment.mockResolvedValue({
    payment: { id: "pay_1", status: "succeeded" },
    alreadyConfirmed: false,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/payments/confirm-mock availability", () => {
  it("does not exist in production, and answers 404 rather than 403", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(jsonRequest({ paymentId: "pay_1" }));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBe(safeMessageForCode("NOT_FOUND"));
    expect(typeof body.requestId).toBe("string");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("stays 404 in production even when the mock flag is switched on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENTS_MOCK_ENABLED", "true");
    expect((await POST(jsonRequest({ paymentId: "pay_1" }))).status).toBe(404);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("can be switched off outside production too", async () => {
    vi.stubEnv("PAYMENTS_MOCK_ENABLED", "false");
    expect((await POST(jsonRequest({ paymentId: "pay_1" }))).status).toBe(404);
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("confirms the named payment when it is enabled", async () => {
    const response = await POST(jsonRequest({ paymentId: "pay_1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { paymentId: "pay_1", status: "succeeded", replay: false, provider: "mock" },
    });
    expect(confirmPayment.mock.calls[0][0]).toMatchObject({ paymentId: "pay_1" });
  });

  it("never lets the caller name the amount it wants to have captured", async () => {
    await POST(jsonRequest({ paymentId: "pay_1", amountCents: 1, currency: "XXX" }));
    const [payload] = confirmPayment.mock.calls[0];
    expect(payload).not.toHaveProperty("amountCents");
    expect(payload).not.toHaveProperty("currency");
    expect(payload.providerReference).toMatch(/^mock_[0-9a-f-]{36}$/);
  });
});

describe("POST /api/payments/confirm-mock request handling", () => {
  it("returns 400 with field-level detail for a missing payment id", async () => {
    const response = await POST(jsonRequest({}));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details[0].path).toBe("paymentId");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("bounds the payment id", async () => {
    const response = await POST(jsonRequest({ paymentId: "p".repeat(65) }));
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("paymentId");
  });

  it("returns 413 before the payment service is reached", async () => {
    const response = await POST(jsonRequest({ paymentId: "pay_1", padding: "x".repeat(3_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(
      new NextRequest("https://hairsimo.it/api/payments/confirm-mock", { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the payment policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.payment);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ paymentId: "pay_1" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ paymentId: "pay_1" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("maps the domain refusals onto the taxonomy", async () => {
    confirmPayment.mockRejectedValue(new Error("PAYMENT_NOT_CONFIRMABLE:already refunded"));
    const conflict = await POST(jsonRequest({ paymentId: "pay_1" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "CONFLICT",
      message: "The payment is not in a confirmable state.",
    });

    confirmPayment.mockRejectedValue(new Error("PAYMENT_NOT_FOUND"));
    const missing = await POST(jsonRequest({ paymentId: "pay_9" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("PAYMENT_NOT_FOUND");
  });

  it("never leaks an unmapped failure to the client", async () => {
    confirmPayment.mockRejectedValue(
      new Error(
        "Invalid `prisma.payment.update()` invocation in /app/packages/core/src/payment-service.ts:412",
      ),
    );

    const response = await POST(jsonRequest({ paymentId: "pay_1" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("/app/packages");
  });
});
