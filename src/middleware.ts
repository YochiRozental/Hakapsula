import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isAdmin = req.auth?.user?.role === "ADMIN";

  // סיסמה זמנית (שהוגדרה ע"י מנהל) — חובה להחליף לפני כל שימוש אחר
  if (isLoggedIn && req.auth?.user?.mustChangePassword) {
    if (pathname === "/change-password") return NextResponse.next();
    return NextResponse.redirect(new URL("/change-password", req.url));
  }
  if (pathname === "/change-password") {
    return NextResponse.redirect(new URL(isLoggedIn ? "/" : "/login", req.url));
  }

  // מנהל רואה רק את אזור הניהול
  if (isAdmin && !pathname.startsWith("/admin")) {
    return NextResponse.redirect(new URL("/admin", req.url));
  }

  if (pathname.startsWith("/admin") && (!isLoggedIn || !isAdmin)) {
    const url = new URL(isLoggedIn ? "/booking" : "/login", req.url);
    if (!isLoggedIn) url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  // עמוד הזמנת החדר (/booking) פתוח לכולם; ההתחברות והפרטים נבדקים רק בעת ההזמנה בפועל
  if (pathname.startsWith("/booking") && pathname !== "/booking" && pathname !== "/booking/") {
    if (!isLoggedIn) {
      const url = new URL("/login", req.url);
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
    // סטטוס האישור ב-session עלול להיות ישן (נשמר ב-JWT), לכן הוא נאכף בשרת מול מסד הנתונים בעת ההזמנה
  }

  // השלמת פרטים דורשת התחברות (גם למשתמש שטרם אושר)
  if (pathname.startsWith("/complete-profile") && !isLoggedIn) {
    const url = new URL("/login", req.url);
    url.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/", "/booking/:path*", "/admin/:path*", "/login", "/register", "/account-status", "/complete-profile", "/change-password"],
};
