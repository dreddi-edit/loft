import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { prisma, type RoleKey } from "@hair-simo/db";

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

export type AuthSession = {
  userId: string;
  email: string;
  role: RoleKey;
  firstName: string;
  lastName: string;
  provider?: "local-jwt" | "identity-platform";
};

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET_MISSING");
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

async function resolveUserSession(userId: string): Promise<AuthSession> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  });
  if (!user || !user.active) throw new Error("USER_NOT_FOUND");
  const role = user.roles[0]?.role.key ?? "staff";
  return {
    userId: user.id,
    email: user.email,
    role,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

export class AuthService {
  async login(rawInput: unknown) {
    const input = loginSchema.parse(rawInput);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { roles: { include: { role: true } } },
    });
    if (!user || !user.active) throw new Error("INVALID_CREDENTIALS");

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) throw new Error("INVALID_CREDENTIALS");

    const session: AuthSession = {
      userId: user.id,
      email: user.email,
      role: user.roles[0]?.role.key ?? "staff",
      firstName: user.firstName,
      lastName: user.lastName,
      provider: "local-jwt",
    };

    const token = await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(getJwtSecret());

    return { token, session };
  }

  async loginWithFirebase(rawInput: unknown) {
    const input = firebaseLoginSchema.parse(rawInput);
    const { verifyIdToken, isIdentityPlatformConfigured } = await import("@hair-simo/gcp/identity-platform");

    if (!isIdentityPlatformConfigured()) {
      throw new Error("IDENTITY_PLATFORM_NOT_ENABLED");
    }

    const identity = await verifyIdToken(input.idToken);
    const user = await prisma.user.findUnique({
      where: { email: identity.email },
      include: { roles: { include: { role: true } } },
    });

    if (!user || !user.active) throw new Error("INVALID_CREDENTIALS");

    const roleFromClaims = (identity.customClaims as { role?: RoleKey }).role;
    const session: AuthSession = {
      userId: user.id,
      email: user.email,
      role: roleFromClaims ?? user.roles[0]?.role.key ?? "staff",
      firstName: user.firstName,
      lastName: user.lastName,
      provider: "identity-platform",
    };

    return { idToken: input.idToken, session };
  }

  async verifyToken(token: string): Promise<AuthSession> {
    if (process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true" && token.split(".").length === 3) {
      try {
        const { verifyIdToken } = await import("@hair-simo/gcp/identity-platform");
        const identity = await verifyIdToken(token);
        const user = await prisma.user.findUnique({ where: { email: identity.email } });
        if (user) {
          const base = await resolveUserSession(user.id);
          return { ...base, provider: "identity-platform" };
        }
      } catch {
        // Fall through to JWT verification for local dev tokens
      }
    }

    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as AuthSession;
  }
}

export function assertRole(session: AuthSession, allowed: RoleKey[]) {
  if (!allowed.includes(session.role)) throw new Error("FORBIDDEN");
}
