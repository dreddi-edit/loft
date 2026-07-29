import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

const createCheckout = vi.fn();

vi.mock("@hair-simo/core", () => ({
  PaymentService: class {
    createCheckout = createCheckout;
  },
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const CHECKOUT = {
  provider: "google-pay",
  paymentId: "pay_1",
  paymentRequired: true,
  providerConfigured: true,
  depositRequired: true,
  amountCents: 2_000,
  tipCents: 0,
  totalChargeCents: 2_000,
  currency: "EUR",
  mode: "deposit",
  pricing: { totalCents: 8_000 },
  googlePayRequest: { apiVersion: 2 },
  internalMargin: 1234,
  customerEmail: "anna@example.com",
};

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/payments/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  createCheckout.mockReset();
  createCheckout.mockResolvedValue(CHECKOUT);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("POST /api/payments/checkout", () => {
  it("returns only the allowlisted checkout projection", async () => {
    const response = await POST(jsonRequest({ appointmentId: "apt_1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.data).sort()).toEqual([
      "amountCents",
      "currency",
      "depositRequired",
      "googlePayRequest",
      "mode",
      "paymentId",
      "paymentRequired",
      "pricing",
      "provider",
      "tipCents",
      "totalChargeCents",
    ]);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("internalMargin");
    expect(encoded).not.toContain("anna@example.com");
    expect(encoded).not.toContain("providerConfigured");
  });

  it("drops the client-supplied amount so a cheap deposit cannot settle an expensive visit", async () => {
    await POST(
      jsonRequest({
        appointmentId: "apt_1",
        serviceSlug: "herren-schnitt",
        depositPercentage: 1,
        amountCents: 1,
        totalChargeCents: 1,
      }),
    );

    const [payload] = createCheckout.mock.calls[0];
    expect(payload).toEqual({ appointmentId: "apt_1", mode: "deposit" });
    expect(payload).not.toHaveProperty("serviceSlug");
    expect(payload).not.toHaveProperty("depositPercentage");
    expect(payload).not.toHaveProperty("amountCents");
  });

  it("returns 400 with field-level detail for a missing or malformed appointment id", async () => {
    const missing = await POST(jsonRequest({}));
    expect(missing.status).toBe(400);
    expect((await missing.json()).details[0].path).toBe("appointmentId");

    const wide = await POST(jsonRequest({ appointmentId: "a".repeat(65) }));
    expect(wide.status).toBe(400);
    expect((await wide.json()).details[0].path).toBe("appointmentId");

    const badMode = await POST(jsonRequest({ appointmentId: "apt_1", mode: "free" }));
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).details[0].path).toBe("mode");

    const negativeTip = await POST(jsonRequest({ appointmentId: "apt_1", tipCents: -100 }));
    expect(negativeTip.status).toBe(400);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("returns 413 before the payment service is reached", async () => {
    const response = await POST(
      jsonRequest({ appointmentId: "apt_1", padding: "x".repeat(5_000) }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("rejects a read method with 405", async () => {
    const response = await POST(new NextRequest("https://hairsimo.it/api/payments/checkout"));
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the payment policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.payment);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest({ appointmentId: "apt_1" }))).status).toBe(200);
    }
    const blocked = await POST(jsonRequest({ appointmentId: "apt_1" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("maps the domain refusals onto the taxonomy", async () => {
    createCheckout.mockRejectedValue(new Error("APPOINTMENT_NOT_PAYABLE:already settled"));
    const conflict = await POST(jsonRequest({ appointmentId: "apt_1" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "CONFLICT",
      message: "This appointment can no longer be paid for.",
    });

    createCheckout.mockRejectedValue(new Error("APPOINTMENT_NOT_FOUND"));
    const missing = await POST(jsonRequest({ appointmentId: "apt_2" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: "APPOINTMENT_NOT_FOUND",
      message: safeMessageForCode("APPOINTMENT_NOT_FOUND"),
    });
  });

  it("never leaks a gateway credential or a stack frame to the client", async () => {
    createCheckout.mockRejectedValue(
      new Error(
        "google pay gateway rejected merchantId=BCR2DN4TREAL secret=sk_live_abcdef " +
          "at /app/packages/core/src/payment-service.ts:180",
      ),
    );

    const response = await POST(jsonRequest({ appointmentId: "apt_1" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("sk_live_");
    expect(encoded).not.toContain("BCR2DN4TREAL");
    expect(encoded).not.toContain("/app/packages");
  });
});
