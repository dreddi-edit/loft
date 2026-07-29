import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextRequest } from "next/server";
import { assertAuthRole, AuthService, type AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const authService = new AuthService();

export const ADMIN_ROLES: RoleKey[] = ["owner", "manager", "staff"];

export async function getSession(): Promise<AuthSession | null> {
  const token = (await cookies()).get("admin_token")?.value;
  if (!token) return null;
  try {
    return await authService.verifyToken(token);
  } catch {
    return null;
  }
}

export async function requireAdminPageSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session || !ADMIN_ROLES.includes(session.role)) redirect("/login");
  return session;
}

export async function requireSession(request: NextRequest, allowed: RoleKey[]) {
  const headerToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const cookieToken = request.cookies.get("admin_token")?.value;
  const token = headerToken || cookieToken;
  if (!token) throw new Error("UNAUTHENTICATED");
  const session = await authService.verifyToken(token);
  assertAuthRole(session, allowed);
  return session;
}
