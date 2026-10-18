import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isAdmin = req.auth?.user?.role === "ADMIN";

  // מנהל רואה רק את אזור הניהול
  if (isAdmin && !pathname.startsWith("/admin")) {
    return NextResponse.redirect(new URL("/admin", req.url));
  }

  if (pathname.startsWith("/admin") && (!isLoggedIn || !isAdmin)) {
    const url = new URL(isLoggedIn ? "/booking" : "/login", req.url);
    if (!isLoggedIn) url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/booking")) {
    if (!isLoggedIn) {
      const url = new URL("/login", req.url);
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
    if (req.auth?.user?.status !== "APPROVED") {
      return NextResponse.redirect(new URL("/account-status", req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/", "/booking/:path*", "/admin/:path*", "/login", "/register", "/account-status"],
};
