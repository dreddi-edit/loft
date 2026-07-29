import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_RATE_LIMIT_POLICIES,
  REQUEST_ID_HEADER,
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  safeMessageForCode,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../lib/admin-api";

const createRefund = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  RefundService: class {
    createRefund = createRefund;
  },
  salonRepository: {},
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const REFUND_RESULT = {
  refund: { id: "ref_1", paymentId: "pay_1", amountCents: 2_000, reason: "goodwill" },
  alreadyRefunded: false,
  refundedCents: 2_000,
  remainingCents: 0,
};

function request(body: unknown, role: string | null = "owner"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/payments/refund", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  audits = [];
  setAdminApiLogSink(() => {});
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  resetAdminRateLimits();
  requireSession.mockClear();
  createRefund.mockReset();
  createRefund.mockResolvedValue(REFUND_RESULT);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("POST /api/payments/refund authorisation", () => {
  it("rejects a missing session with 401 and moves no money", async () => {
    const response = await POST(request({ paymentId: "pay_1" }, null));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(createRefund).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("is closed to the staff role", async () => {
    const response = await POST(request({ paymentId: "pay_1" }, "staff"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(createRefund).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("is bounded by the sensitive policy, not the ordinary mutation one", async () => {
    const definition = ADMIN_RATE_LIMIT_POLICIES.adminSensitive;
    const ceiling = definition.limit + (definition.burst ?? 0);
    expect(ceiling).toBeLessThan(ADMIN_RATE_LIMIT_POLICIES.adminMutation.limit);

    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(request({ paymentId: "pay_1" }))).status).toBe(201);
    }
    const blocked = await POST(request({ paymentId: "pay_1" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
    expect(audits).toHaveLength(ceiling);
  });
});

describe("POST /api/payments/refund audit trail", () => {
  it("writes exactly one audit row naming the payment and the amount", async () => {
    const response = await POST(request({ paymentId: "pay_1", amountCents: 2_000 }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: REFUND_RESULT });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "payment.refund",
      entityType: "payment",
      entityId: "pay_1",
      actorId: "usr_1",
      actorEmail: "owner@hairsimo.it",
      actorRole: "owner",
      ip: "203.0.113.7",
    });
    expect(audits[0].after).toMatchObject({
      refundId: "ref_1",
      paymentId: "pay_1",
      amountCents: 2_000,
    });
  });

  it("redacts anything that looks like a payment instrument from the audit row", async () => {
    await POST(
      request({
        paymentId: "pay_1",
        cardNumber: "4111111111111111",
        cvv: "123",
        providerToken: "tok_live_secret",
      }),
    );
    const encoded = JSON.stringify(audits[0].after);
    expect(encoded).not.toContain("4111111111111111");
    expect(encoded).not.toContain("tok_live_secret");
  });

  it("writes no audit row when the refund is refused", async () => {
    createRefund.mockRejectedValue(new Error("PAYMENT_NOT_REFUNDABLE"));
    const response = await POST(request({ paymentId: "pay_1" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "CONFLICT",
      message: safeMessageForCode("CONFLICT"),
    });
    expect(audits).toHaveLength(0);
  });

  it("maps an over-refund onto a validation error", async () => {
    createRefund.mockRejectedValue(new Error("INVALID_REFUND_AMOUNT:asked 9000 of 2000"));
    const response = await POST(request({ paymentId: "pay_1", amountCents: 9_000 }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body)).not.toContain("asked 9000");
    expect(audits).toHaveLength(0);
  });

  it("returns 413 for an oversized body", async () => {
    const response = await POST(request({ paymentId: "pay_1", reason: "x".repeat(70_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("never leaks the payment provider failure to the browser", async () => {
    createRefund.mockRejectedValue(
      new Error(
        "gateway refund failed for merchant BCR2DN4TREAL with key sk_live_abcdef " +
          "at /app/packages/core/src/refund-service.ts:88",
      ),
    );
    const response = await POST(request({ paymentId: "pay_1" }));
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
    expect(audits).toHaveLength(0);
  });
});
