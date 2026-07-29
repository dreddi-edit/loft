import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { core } = vi.hoisted(() => ({
  core: {
    verifyAppointmentAccessToken: vi.fn(),
    findAppointmentById: vi.fn(),
    issueVerification: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  MAX_VERIFICATION_SENDS: 3,
  VERIFICATION_RESEND_COOLDOWN_MS: 60_000,
  NotificationService: class {
    send = core.send;
  },
  buildVerificationEmail: (input: { locale: string; verifyUrl: string }) => ({
    locale: input.locale,
    subject: "Please confirm your Hair Simo appointment",
    message: `confirm: ${input.verifyUrl}`,
  }),
  issueVerification: core.issueVerification,
  salonRepository: { findAppointmentById: core.findAppointmentById },
  verifyAppointmentAccessToken: core.verifyAppointmentAccessToken,
}));

import { resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { POST } from "./route";

const MANAGE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhcHBvaW50bWVudElkIjoiYXB0XzEifQ.c2lnbmF0dXJl";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const APPOINTMENT = { id: "apt_1", customerId: "cus_1" };

const ISSUED = {
  appointmentId: "apt_1",
  token: "Yx7QsD1kZ2mN4pR6tV8wA0bC3eF5gH7jK9lM1nO3pQ4",
  expiresAt: new Date("2026-08-05T09:00:00.000Z"),
  sentCount: 2,
  locale: "it" as const,
  recipient: "cliente@example.com",
  startsAt: new Date("2026-08-05T13:00:00.000Z"),
  endsAt: new Date("2026-08-05T14:00:00.000Z"),
};

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  core.verifyAppointmentAccessToken.mockReset();
  core.findAppointmentById.mockReset();
  core.issueVerification.mockReset();
  core.send.mockReset();
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://hairsimo.it");
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(body: unknown): NextRequest {
  return new NextRequest("https://hairsimo.it/api/verify/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    body: JSON.stringify(body),
  });
}

function bodylessRequest(method: string): NextRequest {
  return new NextRequest("https://hairsimo.it/api/verify/resend", {
    method,
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

function acceptToken(): void {
  core.verifyAppointmentAccessToken.mockResolvedValue({
    appointmentId: APPOINTMENT.id,
    customerId: APPOINTMENT.customerId,
  });
  core.findAppointmentById.mockResolvedValue(APPOINTMENT);
}

describe("POST /api/verify/resend auth boundary", () => {
  it("refuses a request that names an appointment instead of proving access to it", async () => {
    const response = await POST(request({ appointmentId: "apt_1" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(core.issueVerification).not.toHaveBeenCalled();
  });

  it("refuses extra fields alongside a valid token", async () => {
    acceptToken();

    const response = await POST(request({ token: MANAGE_TOKEN, appointmentId: "apt_other" }));

    expect(response.status).toBe(400);
    expect(core.issueVerification).not.toHaveBeenCalled();
  });

  it("rejects a forged or expired appointment token", async () => {
    core.verifyAppointmentAccessToken.mockRejectedValue(
      new Error("JWSSignatureVerificationFailed"),
    );

    const response = await POST(request({ token: MANAGE_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toBe("This appointment link is invalid or has expired.");
    expect(core.issueVerification).not.toHaveBeenCalled();
    expect(core.send).not.toHaveBeenCalled();
  });

  it("rejects a token whose claims do not match the stored appointment", async () => {
    core.verifyAppointmentAccessToken
      .mockResolvedValueOnce({ appointmentId: "apt_1", customerId: "cus_attacker" })
      .mockRejectedValueOnce(new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH"));
    core.findAppointmentById.mockResolvedValue(APPOINTMENT);

    const response = await POST(request({ token: MANAGE_TOKEN }));

    expect(response.status).toBe(401);
    expect(core.verifyAppointmentAccessToken).toHaveBeenNthCalledWith(2, MANAGE_TOKEN, {
      appointmentId: APPOINTMENT.id,
      customerId: APPOINTMENT.customerId,
    });
    expect(core.issueVerification).not.toHaveBeenCalled();
  });

  it("returns 404 when the token points at an appointment that no longer exists", async () => {
    core.verifyAppointmentAccessToken.mockResolvedValue({
      appointmentId: "apt_gone",
      customerId: "cus_1",
    });
    core.findAppointmentById.mockResolvedValue(null);

    const response = await POST(request({ token: MANAGE_TOKEN }));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("APPOINTMENT_NOT_FOUND");
  });

  it("refuses any method other than POST", async () => {
    const response = await POST(bodylessRequest("GET"));

    expect(response.status).toBe(405);
    expect(core.verifyAppointmentAccessToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/verify/resend delivery", () => {
  it("issues a fresh link and mails it to the address on file", async () => {
    acceptToken();
    core.issueVerification.mockResolvedValue(ISSUED);
    core.send.mockResolvedValue({ status: "sent", provider: "gmail-api" });

    const response = await POST(request({ token: MANAGE_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ status: "sent", sendsRemaining: 1 });
    expect(core.issueVerification).toHaveBeenCalledWith(APPOINTMENT.id);
    expect(core.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "web",
        recipient: ISSUED.recipient,
        locale: "it",
        message: `confirm: https://hairsimo.it/it/verify/${ISSUED.token}`,
      }),
    );
  });

  it("never lets the caller choose the recipient or the locale", async () => {
    acceptToken();
    core.issueVerification.mockResolvedValue(ISSUED);
    core.send.mockResolvedValue({ status: "sent", provider: "gmail-api" });

    await POST(request({ token: MANAGE_TOKEN }));

    expect(core.send.mock.calls[0][0].recipient).toBe(ISSUED.recipient);
    expect(core.send.mock.calls[0][0].locale).toBe(ISSUED.locale);
  });

  it("surfaces a failed send instead of claiming the mail went out", async () => {
    acceptToken();
    core.issueVerification.mockResolvedValue(ISSUED);
    core.send.mockResolvedValue({
      status: "failed",
      provider: "gmail-api",
      reason: "GMAIL_SEND_FAILED",
      detail: "invalid_grant for simo@hairsimo.it",
    });

    const response = await POST(request({ token: MANAGE_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("invalid_grant");
  });

  it("surfaces a transport that throws", async () => {
    acceptToken();
    core.issueVerification.mockResolvedValue(ISSUED);
    core.send.mockRejectedValue(new Error("GMAIL_SENDER_NOT_CONFIGURED"));

    expect((await POST(request({ token: MANAGE_TOKEN }))).status).toBe(503);
  });
});

describe("POST /api/verify/resend throttling", () => {
  it("answers the resend cooldown with 429 and a Retry-After", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("VERIFICATION_RESEND_TOO_SOON"));

    const response = await POST(request({ token: MANAGE_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(body.error).toBe("RATE_LIMITED");
    expect(body.requestId).toBeTruthy();
    expect(core.send).not.toHaveBeenCalled();
  });

  it("answers the absolute send cap with 429 and no Retry-After", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("VERIFICATION_RESEND_LIMIT"));

    const response = await POST(request({ token: MANAGE_TOKEN }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect((await response.json()).message).toContain("maximum number");
  });

  it("answers the per-customer unverified booking cap with 429", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("UNVERIFIED_BOOKING_LIMIT"));

    expect((await POST(request({ token: MANAGE_TOKEN }))).status).toBe(429);
  });

  it("treats an already verified booking as success, not as an error", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("VERIFICATION_ALREADY_VERIFIED"));

    const response = await POST(request({ token: MANAGE_TOKEN }));

    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("already_confirmed");
    expect(core.send).not.toHaveBeenCalled();
  });

  it("maps a booking that is no longer pending onto a conflict", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("APPOINTMENT_NOT_PENDING"));

    const response = await POST(request({ token: MANAGE_TOKEN }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("CONFLICT");
  });

  it("rate limits the endpoint itself, because every call sends mail", async () => {
    acceptToken();
    core.issueVerification.mockResolvedValue(ISSUED);
    core.send.mockResolvedValue({ status: "sent", provider: "gmail-api" });
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);

    for (let attempt = 0; attempt < ceiling; attempt += 1) {
      expect((await POST(request({ token: MANAGE_TOKEN }))).status).toBe(200);
    }

    const blocked = await POST(request({ token: MANAGE_TOKEN }));
    expect(blocked.status).toBe(429);
    expect(core.send).toHaveBeenCalledTimes(ceiling);
  });

  it("never leaks a raw error message from an unmapped failure", async () => {
    acceptToken();
    core.issueVerification.mockRejectedValue(new Error("P1001 can't reach db at 10.0.0.4:5432"));

    const response = await POST(request({ token: MANAGE_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("10.0.0.4");
    expect(logs.at(-1)?.severity).toBe("ERROR");
  });
});
