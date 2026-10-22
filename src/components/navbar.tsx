"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Icon, Logo, type IconName } from "@/components/ui";

const linkClass = (active: boolean) =>
  `flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
    active
      ? "bg-linear-to-b from-brand-500 to-brand-700 text-white shadow-brand"
      : "text-stone-600 hover:bg-bronze-50 hover:text-brand-800"
  }`;

export function Navbar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contactActive, setContactActive] = useState(false);

  useEffect(() => {
    const section = document.getElementById("contact");
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setContactActive(entry.isIntersecting);
      },
      {
        rootMargin: "-80px 0px -40% 0px",
        threshold: 0,
      },
    );

    observer.observe(section);

    return () => observer.disconnect();
  }, [pathname]);

  const isAdmin = session?.user?.role === "ADMIN";
  const isAuthenticated = status === "authenticated";

  const links: {
    href: string;
    label: string;
    icon: IconName;
    active: boolean;
  }[] = [];

  if (isAdmin) {
    links.push({
      href: "/admin",
      label: "ניהול",
      icon: "chart",
      active: pathname?.startsWith("/admin") ?? false,
    });
  } else if (status !== "loading") {
    links.push(
      {
        href: "/",
        label: "דף הבית",
        icon: "home",
        active: pathname === "/" && !contactActive,
      },
      {
        href: "/hours",
        label: "שעות פעילות",
        icon: "clock",
        active: pathname === "/hours" && !contactActive,
      },
      {
        href: "/booking",
        label: "קביעת תור",
        icon: "calendar",
        active: pathname === "/booking" && !contactActive,
      },
    );

    if (isAuthenticated) {
      links.push(
        {
          href: "/booking/my",
          label: "התורים שלי",
          icon: "calendarCheck",
          active: pathname === "/booking/my" && !contactActive,
        },
        {
          href: "/profile",
          label: "הכרטיס שלי",
          icon: "user",
          active: pathname === "/profile" && !contactActive,
        },
      );
    }

    links.push({
      href: "#contact",
      label: "צור קשר",
      icon: "phone",
      active: contactActive,
    });
  }

  const initial = session?.user?.name?.trim().charAt(0) ?? "";

  const authControls =
    status === "authenticated" ? (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-sm text-stone-600">
          <span className="w-9 h-9 rounded-full bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 font-bold flex items-center justify-center ring-1 ring-bronze-200 shadow-sm">
            {initial}
          </span>
          שלום, {session.user?.name}
        </span>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="btn btn-ghost btn-sm"
          title="התנתקות"
        >
          <Icon name="logout" className="w-4 h-4" />
          התנתקות
        </button>
      </div>
    ) : status === "unauthenticated" ? (
      <div className="flex items-center gap-2">
        <Link
          href="/login"
          className={`btn btn-sm ${pathname === "/login" ? "btn-secondary" : "btn-ghost"}`}
        >
          התחברות
        </Link>
        <Link href="/register" className="btn btn-primary btn-sm">
          הרשמה
        </Link>
      </div>
    ) : null;

  return (
    <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md shadow-[0_1px_0_rgb(221_211_196/0.6),0_8px_24px_-18px_rgb(35_48_45/0.25)]">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 px-4 sm:px-6 h-20 py-3">
        <Link
          href={isAdmin ? "/admin" : "/"}
          className="shrink-0"
          onClick={() => setMenuOpen(false)}
        >
          <Logo />
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={linkClass(l.active)}>
              <Icon name={l.icon} className="w-4 h-4" />
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:block">{authControls}</div>

        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="md:hidden btn btn-ghost p-2!"
          aria-label="תפריט"
          aria-expanded={menuOpen}
        >
          <Icon name={menuOpen ? "x" : "menu"} className="w-6 h-6" />
        </button>
      </div>

      <div aria-hidden="true" className="hairline-bronze" />

      {menuOpen && (
        <div className="md:hidden border-t border-cream-200 bg-white px-4 py-4 space-y-3">
          <nav className="flex flex-col gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={linkClass(l.active)}
                onClick={() => setMenuOpen(false)}
              >
                <Icon name={l.icon} className="w-4 h-4" />
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="pt-3 border-t border-cream-100">{authControls}</div>
        </div>
      )}
    </header>
  );
}
