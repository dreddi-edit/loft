import { NextResponse, type NextRequest } from "next/server";
import { resolveLocale, SUPPORTED_LOCALES } from "@hair-simo/i18n";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api") || pathname.startsWith("/_next")) {
    return NextResponse.next();
  }
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first && (SUPPORTED_LOCALES as readonly string[]).includes(first)) {
    return NextResponse.next();
  }
  const locale = resolveLocale(request.headers.get("accept-language")?.slice(0, 2));
  const target = new URL(`/${locale}${pathname === "/" ? "" : pathname}`, request.url);
  return NextResponse.redirect(target);
}

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)"],
};
