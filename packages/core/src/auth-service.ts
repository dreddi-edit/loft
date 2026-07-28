import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { prisma, type RoleKey } from "@hair-simo/db";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type AuthSession = {
  userId: string;
  email: string;
  role: RoleKey;
  firstName: string;
  lastName: string;
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

    const role = user.roles[0]?.role.key ?? "staff";
    const session: AuthSession = {
      userId: user.id,
      email: user.email,
      role,
      firstName: user.firstName,
      lastName: user.lastName,
    };

    const token = await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(getJwtSecret());

    return { token, session };
  }

  async verifyToken(token: string): Promise<AuthSession> {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as AuthSession;
  }
}

export function assertRole(session: AuthSession, allowed: RoleKey[]) {
  if (!allowed.includes(session.role)) throw new Error("FORBIDDEN");
}
