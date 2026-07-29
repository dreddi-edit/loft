import { SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, verifyIdToken } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("@hair-simo/db", () => ({
  prisma: { user: { findUnique } },
  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({
    tenantId_email: { tenantId: "cltenant00000000000000001", email },
  }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({
    tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek },
  }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },
}));

vi.mock("@hair-simo/gcp/identity-platform", () => ({
  verifyIdToken,
  isIdentityPlatformConfigured: () => true,
}));

import {
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_TYPE,
  AuthService,
  TOKEN_ISSUER,
  hashPassword,
  verifyPassword,
} from "./auth-service";
import { createAppointmentAccessToken } from "./appointment-token";
import {
  checkLoginThrottle,
  extractClientIp,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
} from "../../../apps/admin/lib/login-throttle";

const secret = "admin-secret-for-tests-000000000000";
const password = "correct-horse-battery-staple";
const email = "owner@hairsimo.it";
const updatedAt = new Date("2026-07-01T10:00:00.000Z");
const originalEnv = { ...process.env };

let passwordHash: string;

function dbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email,
    passwordHash,
    firstName: "Simona",
    lastName: "Bianchi",
    active: true,
    updatedAt,
    tenantId: "cltenant00000000000000001",
    tenant: { slug: "hairsimo-brixen" },
    roles: [{ role: { key: "owner" } }],
    ...overrides,
  };
}

async function login() {
  findUnique.mockResolvedValue(dbUser());
  return new AuthService().login({ email, password });
}

describe("auth password helpers", () => {
  it("hashes and verifies password", async () => {
    const hash = await hashPassword("test-password-12");
    expect(hash).not.toBe("test-password-12");
    await expect(verifyPassword("test-password-12", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });
});

describe("admin session tokens", () => {
  beforeAll(async () => {
    passwordHash = await hashPassword(password);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_JWT_SECRET = secret;
    process.env.APPOINTMENT_TOKEN_SECRET = secret;
    delete process.env.JWT_SECRET;
    delete process.env.GCP_IDENTITY_PLATFORM_ENABLED;
    delete process.env.GCP_PROJECT_ID;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("takes the role from the database and not from the token", async () => {
    const { token, session } = await login();
    expect(session.role).toBe("owner");

    findUnique.mockResolvedValue(dbUser({ roles: [{ role: { key: "staff" } }] }));
    const verified = await new AuthService().verifyToken(token);
    expect(verified.role).toBe("staff");
    expect(verified.provider).toBe("local-jwt");
  });

  it("rejects a token whose user was deactivated", async () => {
    const { token } = await login();
    findUnique.mockResolvedValue(dbUser({ active: false }));
    await expect(new AuthService().verifyToken(token)).rejects.toThrow("USER_NOT_FOUND");
  });

  it("rejects a token whose user was deleted", async () => {
    const { token } = await login();
    findUnique.mockResolvedValue(null);
    await expect(new AuthService().verifyToken(token)).rejects.toThrow("USER_NOT_FOUND");
  });

  it("rejects a token after the user record was touched", async () => {
    const { token } = await login();
    findUnique.mockResolvedValue(dbUser({ updatedAt: new Date(updatedAt.getTime() + 1_000) }));
    await expect(new AuthService().verifyToken(token)).rejects.toThrow("TOKEN_REVOKED");
  });

  it("rejects an appointment audience token signed with the same secret", async () => {
    const token = await createAppointmentAccessToken({
      appointmentId: "appointment-1",
      customerId: "customer-1",
    });
    await expect(new AuthService().verifyToken(token)).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects an admin token that carries an unknown role", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      typ: ADMIN_TOKEN_TYPE,
      userId: "user-1",
      email,
      role: "superuser",
      firstName: "Simona",
      lastName: "Bianchi",
      tenantId: "cltenant00000000000000001",
      tenantSlug: "hairsimo-brixen",
      tokenVersion: String(updatedAt.getTime()),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(ADMIN_TOKEN_AUDIENCE)
      .setSubject("user-1")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(secret));

    await expect(new AuthService().verifyToken(token)).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a token whose subject was swapped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      typ: ADMIN_TOKEN_TYPE,
      userId: "user-1",
      email,
      role: "owner",
      firstName: "Simona",
      lastName: "Bianchi",
      tenantId: "cltenant00000000000000001",
      tenantSlug: "hairsimo-brixen",
      tokenVersion: String(updatedAt.getTime()),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(ADMIN_TOKEN_AUDIENCE)
      .setSubject("user-2")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(secret));

    await expect(new AuthService().verifyToken(token)).rejects.toThrow(
      "ADMIN_TOKEN_SUBJECT_MISMATCH",
    );
  });

  it("disables the local JWT path in production when Identity Platform is enabled", async () => {
    const { token } = await login();
    verifyIdToken.mockRejectedValue(new Error("INVALID_ID_TOKEN"));
    process.env.GCP_IDENTITY_PLATFORM_ENABLED = "true";
    process.env.NODE_ENV = "production";

    await expect(new AuthService().verifyToken(token)).rejects.toThrow(
      "IDENTITY_PLATFORM_VERIFICATION_FAILED",
    );
    await expect(new AuthService().verifyToken("not-a-jwt")).rejects.toThrow("LOCAL_JWT_DISABLED");
  });

  it("keeps the local JWT fallthrough outside production", async () => {
    const { token } = await login();
    verifyIdToken.mockRejectedValue(new Error("INVALID_ID_TOKEN"));
    process.env.GCP_IDENTITY_PLATFORM_ENABLED = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    findUnique.mockResolvedValue(dbUser());
    await expect(new AuthService().verifyToken(token)).resolves.toMatchObject({
      userId: "user-1",
      role: "owner",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("runs a password comparison even when the email is unknown", async () => {
    findUnique.mockResolvedValue(dbUser());
    const knownStart = performance.now();
    await expect(
      new AuthService().login({ email, password: "totally-wrong-password" }),
    ).rejects.toThrow("INVALID_CREDENTIALS");
    const knownDuration = performance.now() - knownStart;

    findUnique.mockResolvedValue(null);
    const unknownStart = performance.now();
    await expect(
      new AuthService().login({ email: "ghost@hairsimo.it", password: "totally-wrong-password" }),
    ).rejects.toThrow("INVALID_CREDENTIALS");
    const unknownDuration = performance.now() - unknownStart;

    expect(unknownDuration).toBeGreaterThan(20);
    expect(unknownDuration).toBeGreaterThan(knownDuration * 0.5);
  });
});

describe("admin login throttle", () => {
  beforeEach(() => {
    resetLoginThrottle();
  });

  it("takes the client ip from the second entry from the right", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 203.0.113.9, 35.191.0.1",
    });
    expect(extractClientIp(headers)).toBe("203.0.113.9");
    expect(extractClientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(extractClientIp(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(extractClientIp(new Headers())).toBe("unknown");
  });

  it("blocks with exponential backoff after repeated failures", () => {
    const identity = { ip: "203.0.113.9", email: "owner@hairsimo.it" };
    const now = 1_000_000;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordLoginFailure(identity, now);
      expect(checkLoginThrottle(identity, now).allowed).toBe(true);
    }

    recordLoginFailure(identity, now);
    const first = checkLoginThrottle(identity, now);
    expect(first.allowed).toBe(false);
    expect(first.retryAfterSeconds).toBeGreaterThan(0);

    recordLoginFailure(identity, now);
    const second = checkLoginThrottle(identity, now);
    expect(second.retryAfterSeconds).toBeGreaterThan(first.retryAfterSeconds);

    expect(checkLoginThrottle(identity, now + 60_000).allowed).toBe(true);
  });

  it("blocks the email across ip addresses and clears on success", () => {
    const now = 2_000_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      recordLoginFailure({ ip: `198.51.100.${attempt}`, email: "owner@hairsimo.it" }, now);
    }

    expect(checkLoginThrottle({ ip: "203.0.113.9", email: "owner@hairsimo.it" }, now).allowed).toBe(
      false,
    );
    expect(checkLoginThrottle({ ip: "203.0.113.9", email: "other@hairsimo.it" }, now).allowed).toBe(
      true,
    );

    recordLoginSuccess({ ip: "203.0.113.9", email: "owner@hairsimo.it" });
    expect(checkLoginThrottle({ ip: "203.0.113.9", email: "owner@hairsimo.it" }, now).allowed).toBe(
      true,
    );
  });
});
