import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { prisma, DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG, tenantEmailKey, type RoleKey } from "@hair-simo/db";

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
  })
  .strict();

const firebaseLoginSchema = z
  .object({
    idToken: z.string().min(1),
  })
  .strict();

export const TOKEN_ISSUER = "hair-simo";
export const ADMIN_TOKEN_AUDIENCE = "hair-simo-admin";
export const ADMIN_TOKEN_TYPE = "admin-session";
export const ADMIN_ROLE_KEYS = ["owner", "manager", "staff"] as const;

const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 12;
const CLOCK_TOLERANCE_SECONDS = 30;

// bcrypt hash of a random string, never matches a real password. Used so that a login
// attempt for an unknown or deactivated account still pays the full comparison cost.
const DUMMY_PASSWORD_HASH = "$2b$12$7RM11wfJxAkM8t4q2AxNBOiPXT9Dc7F9wLVCn93XGz8hxpusHPqpa";

export type TokenSecretName = "ADMIN_JWT_SECRET" | "APPOINTMENT_TOKEN_SECRET";

export type AuthSession = {
  userId: string;
  email: string;
  role: RoleKey;
  firstName: string;
  lastName: string;
  tenantId: string;
  tenantSlug: string;
  provider?: "local-jwt" | "identity-platform";
};

const adminTokenClaimsSchema = z.object({
  typ: z.literal(ADMIN_TOKEN_TYPE),
  userId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(ADMIN_ROLE_KEYS),
  firstName: z.string(),
  lastName: z.string(),
  tenantId: z.string().min(1),
  tenantSlug: z.string().min(1),
  tokenVersion: z.string().min(1),
  provider: z.enum(["local-jwt", "identity-platform"]).optional(),
});

export type AdminTokenClaims = z.infer<typeof adminTokenClaimsSchema>;

const warnedSecretFallbacks = new Set<TokenSecretName>();

export function resolveTokenSecret(name: TokenSecretName) {
  const dedicated = process.env[name];
  if (dedicated) return new TextEncoder().encode(dedicated);

  const shared = process.env.JWT_SECRET;
  if (!shared) throw new Error(`${name}_MISSING`);
  if (!warnedSecretFallbacks.has(name)) {
    warnedSecretFallbacks.add(name);
    console.warn(
      `[auth:secret-fallback] ${name} is not set, falling back to the shared JWT_SECRET. ` +
        "Admin sessions and customer appointment links are then signed with the same key.",
    );
  }
  return new TextEncoder().encode(shared);
}

export function timingSafeStringEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

function toTokenVersion(updatedAt: Date) {
  return String(new Date(updatedAt).getTime());
}

type ResolvedUser = { session: AuthSession; tokenVersion: string };

async function resolveUserSession(userId: string): Promise<ResolvedUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } }, tenant: true },
  });
  if (!user || !user.active) throw new Error("USER_NOT_FOUND");
  const role = user.roles[0]?.role.key ?? "staff";
  return {
    session: {
      userId: user.id,
      email: user.email,
      role,
      firstName: user.firstName,
      lastName: user.lastName,
      tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
      tenantSlug: user.tenant?.slug ?? DEFAULT_TENANT_SLUG,
    },
    tokenVersion: toTokenVersion(user.updatedAt),
  };
}

async function signAdminSessionToken(session: AuthSession, tokenVersion: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...session, typ: ADMIN_TOKEN_TYPE, tokenVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(ADMIN_TOKEN_AUDIENCE)
    .setSubject(session.userId)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + ADMIN_TOKEN_TTL_SECONDS)
    .sign(resolveTokenSecret("ADMIN_JWT_SECRET"));
}

export async function verifyAdminSessionToken(token: string): Promise<AdminTokenClaims> {
  const { payload } = await jwtVerify(token, resolveTokenSecret("ADMIN_JWT_SECRET"), {
    algorithms: ["HS256"],
    issuer: TOKEN_ISSUER,
    audience: ADMIN_TOKEN_AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  const claims = adminTokenClaimsSchema.parse(payload);
  if (!payload.sub || !timingSafeStringEqual(payload.sub, claims.userId)) {
    throw new Error("ADMIN_TOKEN_SUBJECT_MISMATCH");
  }
  return claims;
}

export class AuthService {
  async login(rawInput: unknown) {
    const input = loginSchema.parse(rawInput);
    const user = await prisma.user.findUnique({
      where: tenantEmailKey(input.email),
      include: { roles: { include: { role: true } }, tenant: true },
    });

    const passwordHash = user && user.active ? user.passwordHash : DUMMY_PASSWORD_HASH;
    const valid = await verifyPassword(input.password, passwordHash);
    if (!user || !user.active || !valid) throw new Error("INVALID_CREDENTIALS");

    const session: AuthSession = {
      userId: user.id,
      email: user.email,
      role: user.roles[0]?.role.key ?? "staff",
      firstName: user.firstName,
      lastName: user.lastName,
      tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
      tenantSlug: user.tenant?.slug ?? DEFAULT_TENANT_SLUG,
      provider: "local-jwt",
    };

    const token = await signAdminSessionToken(session, toTokenVersion(user.updatedAt));

    return { token, session };
  }

  async loginWithFirebase(rawInput: unknown) {
    const input = firebaseLoginSchema.parse(rawInput);
    const { verifyIdToken, isIdentityPlatformConfigured } =
      await import("@hair-simo/gcp/identity-platform");

    if (!isIdentityPlatformConfigured()) {
      throw new Error("IDENTITY_PLATFORM_NOT_ENABLED");
    }

    const identity = await verifyIdToken(input.idToken);
    const user = await prisma.user.findUnique({ where: tenantEmailKey(identity.email) });
    if (!user) throw new Error("INVALID_CREDENTIALS");

    const resolved = await resolveUserSession(user.id);
    const session: AuthSession = { ...resolved.session, provider: "identity-platform" };
    return { idToken: input.idToken, session };
  }

  async verifyToken(token: string): Promise<AuthSession> {
    const identityPlatformEnabled = process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true";
    const production = process.env.NODE_ENV === "production";

    if (identityPlatformEnabled && token.split(".").length === 3) {
      try {
        const { verifyIdToken } = await import("@hair-simo/gcp/identity-platform");
        const identity = await verifyIdToken(token);
        const user = await prisma.user.findUnique({ where: tenantEmailKey(identity.email) });
        if (!user) throw new Error("USER_NOT_FOUND");
        const resolved = await resolveUserSession(user.id);
        return { ...resolved.session, provider: "identity-platform" };
      } catch (error) {
        if (production) throw new Error("IDENTITY_PLATFORM_VERIFICATION_FAILED");
        console.warn(
          "[auth:identity-platform-fallthrough] Identity Platform verification failed, " +
            "retrying with the local HS256 path. This fallback exists in development only.",
          error,
        );
      }
    }

    if (identityPlatformEnabled && production) throw new Error("LOCAL_JWT_DISABLED");

    const claims = await verifyAdminSessionToken(token);
    const resolved = await resolveUserSession(claims.userId);
    if (!timingSafeStringEqual(claims.tokenVersion, resolved.tokenVersion)) {
      throw new Error("TOKEN_REVOKED");
    }
    return { ...resolved.session, provider: "local-jwt" };
  }
}

export function assertRole(session: AuthSession, allowed: RoleKey[]) {
  if (!allowed.includes(session.role)) throw new Error("FORBIDDEN");
}
