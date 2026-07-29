import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const publicPaths = ["/login", "/api/auth/login"];

// Duplicated from @hair-simo/core on purpose: the middleware runs in the Edge runtime and
// cannot import the core package (Prisma, bcrypt, node:crypto). Keep in sync with
// packages/core/src/auth-service.ts.
const TOKEN_ISSUER = "hair-simo";
const ADMIN_TOKEN_AUDIENCE = "hair-simo-admin";
const ADMIN_TOKEN_TYPE = "admin-session";
const ADMIN_ROLES = new Set(["owner", "manager", "staff"]);
const CLOCK_TOLERANCE_SECONDS = 30;

function getAdminSecret() {
  const secret = process.env.ADMIN_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

async function hasValidAdminToken(token: string | undefined) {
  const secret = getAdminSecret();
  if (!token || !secret) return false;
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.typ !== ADMIN_TOKEN_TYPE) return false;
    return typeof payload.role === "string" && ADMIN_ROLES.has(payload.role);
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/auth/logout")) {
    return NextResponse.next();
  }

  const valid = await hasValidAdminToken(request.cookies.get("admin_token")?.value);

  if (!valid) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("admin_token");
    return response;
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:css|js|map|ico|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2|ttf|txt|xml|json)$).*)",
  ],
};
