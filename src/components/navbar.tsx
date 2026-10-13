"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";

const linkClass = (active: boolean) =>
  `px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    active
      ? "bg-teal-600 text-white"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;

export function Navbar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-5xl mx-auto flex items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-bold text-teal-700">
          קליניקות · קביעת תורים
        </Link>

        <nav className="flex items-center gap-2">
          <Link
            href="/booking"
            className={linkClass(pathname?.startsWith("/booking") ?? false)}
          >
            קביעת תור
          </Link>
          {status === "authenticated" && (
            <Link
              href="/booking/my"
              className={linkClass(pathname === "/booking/my")}
            >
              התורים שלי
            </Link>
          )}
          {session?.user?.role === "ADMIN" && (
            <Link
              href="/admin"
              className={linkClass(pathname?.startsWith("/admin") ?? false)}
            >
              ניהול
            </Link>
          )}

          {status === "authenticated" ? (
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              התנתקות ({session.user?.name})
            </button>
          ) : status === "unauthenticated" ? (
            <>
              <Link href="/login" className={linkClass(pathname === "/login")}>
                התחברות
              </Link>
              <Link
                href="/register"
                className="px-3 py-2 rounded-lg text-sm font-medium bg-teal-600 text-white hover:bg-teal-700"
              >
                הרשמה
              </Link>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
