import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@hair-simo/core";

const authService = new AuthService();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await authService.login(body);
    const response = NextResponse.json({ data: { session: result.session } });
    response.cookies.set("admin_token", result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: "LOGIN_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 401 },
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("admin_token", "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
