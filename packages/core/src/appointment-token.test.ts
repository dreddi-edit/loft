import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPOINTMENT_TOKEN_AUDIENCE,
  APPOINTMENT_TOKEN_TYPE,
  createAppointmentAccessToken,
  verifyAppointmentAccessToken,
} from "./appointment-token";
import { ADMIN_TOKEN_AUDIENCE, ADMIN_TOKEN_TYPE, TOKEN_ISSUER } from "./auth-service";

const secret = "appointment-secret-for-tests-0000000000";
const originalEnv = { ...process.env };

function encode(value: string) {
  return new TextEncoder().encode(value);
}

type Claims = Record<string, unknown>;

async function signToken(
  claims: Claims,
  options: {
    secret?: string;
    audience?: string;
    issuer?: string;
    subject?: string;
    notBefore?: number;
    expirationTime?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(options.issuer ?? TOKEN_ISSUER)
    .setAudience(options.audience ?? APPOINTMENT_TOKEN_AUDIENCE)
    .setSubject(options.subject ?? String(claims.appointmentId ?? "appointment-1"))
    .setIssuedAt(now)
    .setNotBefore(options.notBefore ?? now)
    .setExpirationTime(options.expirationTime ?? now + 3600)
    .sign(encode(options.secret ?? secret));
}

describe("appointment access tokens", () => {
  beforeEach(() => {
    process.env.APPOINTMENT_TOKEN_SECRET = secret;
    process.env.ADMIN_JWT_SECRET = secret;
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round trips appointment and customer id", async () => {
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(verifyAppointmentAccessToken(token)).resolves.toEqual({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
  });

  it("keeps the lifetime below 45 days and above the appointment start", async () => {
    const startsAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
      startsAt,
    });
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp: number; nbf: number };
    expect(payload.nbf).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.exp * 1000).toBeGreaterThan(startsAt.getTime());
    expect(payload.exp * 1000).toBeLessThan(Date.now() + 46 * 24 * 60 * 60 * 1000);
  });

  it("rejects an admin audience token even when the secret is shared", async () => {
    const adminToken = await signToken(
      {
        typ: ADMIN_TOKEN_TYPE,
        userId: "user-1",
        email: "owner@hairsimo.it",
        role: "owner",
        firstName: "Simona",
        lastName: "Bianchi",
        tokenVersion: "1",
      },
      { audience: ADMIN_TOKEN_AUDIENCE, subject: "user-1" },
    );
    await expect(verifyAppointmentAccessToken(adminToken)).rejects.toThrow();
  });

  it("is rejected by the admin verifier", async () => {
    const { verifyAdminSessionToken } = await import("./auth-service");
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(verifyAdminSessionToken(token)).rejects.toThrow();
  });

  it("rejects a foreign issuer", async () => {
    const token = await signToken(
      { typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1", customerId: "customer-1" },
      { issuer: "someone-else" },
    );
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1", customerId: "customer-1" },
      { notBefore: now - 7200, expirationTime: now - 3600 },
    );
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token that is not valid yet", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1", customerId: "customer-1" },
      { notBefore: now + 3600, expirationTime: now + 7200 },
    );
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects a tampered payload", async () => {
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Claims;
    decoded.appointmentId = "appointment-2";
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    await expect(
      verifyAppointmentAccessToken(`${header}.${forged}.${signature}`),
    ).rejects.toThrow();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(
      { typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1", customerId: "customer-1" },
      { secret: "another-secret-that-is-long-enough-0000" },
    );
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects a malformed payload", async () => {
    const token = await signToken({ typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1" });
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects a payload whose type claim is wrong", async () => {
    const token = await signToken({
      typ: "something-else",
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token whose subject binds a different appointment", async () => {
    const token = await signToken(
      { typ: APPOINTMENT_TOKEN_TYPE, appointmentId: "appointment-1", customerId: "customer-1" },
      { subject: "appointment-2" },
    );
    await expect(verifyAppointmentAccessToken(token)).rejects.toThrow(
      "APPOINTMENT_TOKEN_BINDING_MISMATCH",
    );
  });

  it("rejects when the expected appointment or customer does not match", async () => {
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(
      verifyAppointmentAccessToken(token, { appointmentId: "appointment-2" }),
    ).rejects.toThrow("APPOINTMENT_TOKEN_BINDING_MISMATCH");
    await expect(verifyAppointmentAccessToken(token, { customerId: "customer-2" })).rejects.toThrow(
      "APPOINTMENT_TOKEN_BINDING_MISMATCH",
    );
    await expect(
      verifyAppointmentAccessToken(token, {
        appointmentId: "appointment-1",
        customerId: "customer-1",
      }),
    ).resolves.toEqual({ appointmentId: "appointment-1", customerId: "customer-1" });
  });

  it("falls back to JWT_SECRET when no dedicated secret is configured", async () => {
    delete process.env.APPOINTMENT_TOKEN_SECRET;
    process.env.JWT_SECRET = "shared-legacy-secret-0000000000000000";
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(verifyAppointmentAccessToken(token)).resolves.toEqual({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
  });
});
