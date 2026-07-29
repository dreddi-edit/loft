import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@hair-simo/core";
import {
  checkLoginThrottle,
  extractClientIp,
  recordLoginFailure,
  recordLoginSuccess,
  type LoginThrottleIdentity,
} from "../../../../lib/login-throttle";

const authService = new AuthService();

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 12;

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

export async function POST(request: NextRequest) {
  const identity: LoginThrottleIdentity = { ip: extractClientIp(request.headers) };
  try {
    const body = await request.json();
    if (typeof body?.email === "string") identity.email = body.email;

    const throttle = checkLoginThrottle(identity);
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: "TOO_MANY_ATTEMPTS", message: "TOO_MANY_ATTEMPTS" },
        { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
      );
    }

    if (body.idToken) {
      const result = await authService.loginWithFirebase(body);
      recordLoginSuccess(identity);
      const response = NextResponse.json({
        data: { session: result.session, provider: "identity-platform" },
      });
      response.cookies.set("admin_token", result.idToken, sessionCookieOptions());
      return response;
    }

    const result = await authService.login(body);
    recordLoginSuccess(identity);
    const response = NextResponse.json({
      data: { session: result.session, provider: "local-jwt" },
    });
    response.cookies.set("admin_token", result.token, sessionCookieOptions());
    return response;
  } catch {
    recordLoginFailure(identity);
    return NextResponse.json(
      { error: "LOGIN_FAILED", message: "INVALID_CREDENTIALS" },
      { status: 401 },
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("admin_token", "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
