import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route protection (Next.js 16 proxy). Redirects visitors without a
 * session cookie away from /app and /admin. The cookie's presence is only a
 * hint: every protected page and API route validates the session server-side,
 * and the sign-in page sends already-authenticated users on to /app itself (so
 * a stale cookie can never cause a redirect loop).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/admin/:path*"],
};
