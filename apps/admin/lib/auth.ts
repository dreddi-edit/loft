import { NextRequest } from "next/server";

const ALLOWED_ROLES = ["owner", "manager", "staff"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

export function getRoleFromRequest(request: NextRequest): AllowedRole | null {
  const value = request.headers.get("x-role");
  if (value && (ALLOWED_ROLES as readonly string[]).includes(value)) return value as AllowedRole;
  return null;
}

export function assertRole(request: NextRequest, allowed: AllowedRole[]) {
  const role = getRoleFromRequest(request);
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return role;
}
