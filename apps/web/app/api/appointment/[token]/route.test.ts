import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../../lib/api-errors";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";

type Claims = { appointmentId: string; customerId: string };
type Binding = { appointmentId?: string; customerId?: string };

const TOKEN_CLAIMS: Record<string, Claims> = {
  tok_a: { appointmentId: "apt_a", customerId: "cus_a" },
  tok_b: { appointmentId: "apt_b", customerId: "cus_b" },
};

/**
 * Mirrors packages/core/src/appointment-token.ts: the claims name the appointment, and an
 * `expected` binding that disagrees with them is a hard failure.
 */
const verifyAppointmentAccessToken = vi.fn(async (token: string, expected?: Binding) => {
  const claims = TOKEN_CLAIMS[token];
  if (!claims) throw new Error("INVALID_TOKEN");
  if (expected?.appointmentId && expected.appointmentId !== claims.appointmentId) {
    throw new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH");
  }
  if (expected?.customerId && expected.customerId !== claims.customerId) {
    throw new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH");
  }
  return claims;
});

const findAppointmentById = vi.fn();
const cancel = vi.fn();
const reschedule = vi.fn();

vi.mock("@hair-simo/core", () => ({
  BookingService: class {
    cancel = cancel;
    reschedule = reschedule;
  },
  salonRepository: { findAppointmentById: (...args: unknown[]) => findAppointmentById(...args) },
  verifyAppointmentAccessToken: (token: string, expected?: Binding) =>
    verifyAppointmentAccessToken(token, expected),
}));

const { GET, POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

function appointmentRow(id: string, customerId: string) {
  return {
    id,
    customerId,
    status: "confirmed",
    startsAt: "2026-08-01T07:00:00.000Z",
    endsAt: "2026-08-01T08:00:00.000Z",
    locale: "de",
    service: {
      slug: "damen-schnitt",
      translations: [{ locale: "de", name: "Damenschnitt", description: "long text" }],
    },
    staff: { displayName: "Simo", email: "simo@hairsimo.it" },
    customer: {
      firstName: "Anna",
      lastName: "Bianchi",
      email: "anna@example.com",
      phone: "+39 333 1234567",
    },
    internalNote: "customer disputed the last invoice",
  };
}

function context(token: string) {
  return { params: Promise.resolve({ token }) };
}

function getRequest(token: string): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/appointment/${token}`, {
    method: "GET",
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

function postRequest(token: string, body: unknown): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/appointment/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  verifyAppointmentAccessToken.mockClear();
  findAppointmentById.mockReset();
  cancel.mockReset();
  reschedule.mockReset();
  findAppointmentById.mockImplementation(async (id: string) =>
    id === "apt_a"
      ? appointmentRow("apt_a", "cus_a")
      : id === "apt_b"
        ? appointmentRow("apt_b", "cus_b")
        : null,
  );
  cancel.mockResolvedValue(undefined);
  reschedule.mockResolvedValue(undefined);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.restoreAllMocks();
});

describe("GET /api/appointment/[token]", () => {
  it("returns only the fields the manage screen renders", async () => {
    const response = await GET(getRequest("tok_a"), context("tok_a"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(Object.keys(body.data).sort()).toEqual([
      "customer",
      "endsAt",
      "id",
      "locale",
      "service",
      "staff",
      "startsAt",
      "status",
    ]);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("anna@example.com");
    expect(encoded).not.toContain("+39 333 1234567");
    expect(encoded).not.toContain("simo@hairsimo.it");
    expect(encoded).not.toContain("disputed the last invoice");
  });

  it("verifies the token twice: once to resolve the row, once against the row itself", async () => {
    await GET(getRequest("tok_a"), context("tok_a"));
    expect(verifyAppointmentAccessToken).toHaveBeenCalledTimes(2);
    expect(verifyAppointmentAccessToken).toHaveBeenNthCalledWith(1, "tok_a", undefined);
    expect(verifyAppointmentAccessToken).toHaveBeenNthCalledWith(2, "tok_a", {
      appointmentId: "apt_a",
      customerId: "cus_a",
    });
  });

  it("rejects an unknown or expired token with 401 and no detail", async () => {
    const response = await GET(getRequest("tok_forged"), context("tok_forged"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "UNAUTHORIZED",
      message: "This appointment link is invalid or has expired.",
    });
    expect(JSON.stringify(body)).not.toContain("INVALID_TOKEN");
    expect(findAppointmentById).not.toHaveBeenCalled();
  });

  it("returns 404 when a valid token names an appointment that no longer exists", async () => {
    findAppointmentById.mockResolvedValue(null);
    const response = await GET(getRequest("tok_a"), context("tok_a"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "APPOINTMENT_NOT_FOUND",
      message: safeMessageForCode("APPOINTMENT_NOT_FOUND"),
    });
  });

  it("refuses the row when the second binding check disagrees with the claims", async () => {
    findAppointmentById.mockResolvedValue(appointmentRow("apt_a", "cus_someone_else"));
    const response = await GET(getRequest("tok_a"), context("tok_a"));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
  });

  it("returns 429 with Retry-After once the availability policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.availability);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await GET(getRequest("tok_a"), context("tok_a"))).status).toBe(200);
    }
    const blocked = await GET(getRequest("tok_a"), context("tok_a"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });
});

describe("POST /api/appointment/[token] authorisation boundary", () => {
  it("cancels only the appointment the token was minted for", async () => {
    const response = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("apt_a", "customer request");
  });

  it("a token for appointment A cannot act on appointment B", async () => {
    const response = await POST(
      postRequest("tok_a", { action: "cancel", appointmentId: "apt_b", id: "apt_b" }),
      context("tok_a"),
    );

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("apt_a", "customer request");
    expect(cancel).not.toHaveBeenCalledWith("apt_b", expect.anything());
    expect(findAppointmentById).not.toHaveBeenCalledWith("apt_b");
  });

  it("a token for appointment A cannot reschedule appointment B", async () => {
    const response = await POST(
      postRequest("tok_a", {
        action: "reschedule",
        startsAt: "2026-08-02T07:00:00.000Z",
        appointmentId: "apt_b",
      }),
      context("tok_a"),
    );

    expect(response.status).toBe(200);
    expect(reschedule).toHaveBeenCalledExactlyOnceWith("apt_a", "2026-08-02T07:00:00.000Z");
  });

  it("refuses to mutate when the loaded row is not the row the token is bound to", async () => {
    findAppointmentById.mockResolvedValue(appointmentRow("apt_b", "cus_b"));
    const response = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a forged token before any mutation runs", async () => {
    const response = await POST(
      postRequest("tok_forged", { action: "cancel" }),
      context("tok_forged"),
    );
    expect(response.status).toBe(401);
    expect(cancel).not.toHaveBeenCalled();
    expect(reschedule).not.toHaveBeenCalled();
  });
});

describe("POST /api/appointment/[token] input handling", () => {
  it("rejects an unknown action with 400", async () => {
    const response = await POST(
      postRequest("tok_a", { action: "refund", amountCents: 5_000 }),
      context("tok_a"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a reschedule without a valid instant", async () => {
    const response = await POST(
      postRequest("tok_a", { action: "reschedule", startsAt: "tomorrow" }),
      context("tok_a"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("startsAt");
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("bounds the cancellation reason", async () => {
    const response = await POST(
      postRequest("tok_a", { action: "cancel", reason: "x".repeat(501) }),
      context("tok_a"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe("reason");
  });

  it("returns 413 for an oversized body before the token is verified", async () => {
    const response = await POST(
      postRequest("tok_a", { action: "cancel", reason: "x".repeat(4_000) }),
      context("tok_a"),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(verifyAppointmentAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a method the route does not implement", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/appointment/tok_a", { method: "DELETE" }),
      context("tok_a"),
    );
    expect(response.status).toBe(405);
    expect((await response.json()).error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 429 with Retry-After once the booking policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.booking);
    for (let index = 0; index < ceiling; index += 1) {
      const ok = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("translates a domain refusal and never leaks an unmapped failure", async () => {
    cancel.mockRejectedValue(new Error("BOOKING_TOO_SOON"));
    const domain = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));
    expect(domain.status).toBe(409);
    expect((await domain.json()).error).toBe("SLOT_NOT_AVAILABLE");

    cancel.mockRejectedValue(
      new Error(
        "Invalid `prisma.appointment.update()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const leaky = await POST(postRequest("tok_a", { action: "cancel" }), context("tok_a"));
    const body = await leaky.json();
    expect(leaky.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: leaky.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(JSON.stringify(body)).not.toContain("/app/packages");
  });
});
