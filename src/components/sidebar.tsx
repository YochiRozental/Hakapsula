"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Icon, Logo, LogoMark, type IconName } from "@/components/ui";

type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
};

function NavLink({
  link,
  collapsed,
  onNavigate,
}: {
  link: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      title={collapsed ? link.label : undefined}
      aria-current={link.active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
        collapsed ? "justify-center" : ""
      } ${
        link.active
          ? "bg-linear-to-b from-brand-500 to-brand-700 text-white shadow-brand"
          : "text-stone-600 hover:bg-bronze-50 hover:text-brand-800"
      }`}
    >
      <Icon
        name={link.icon}
        className={`w-5 h-5 shrink-0 ${link.active ? "" : "text-bronze-500"}`}
      />
      {!collapsed && <span className="truncate">{link.label}</span>}
    </Link>
  );
}

function AdminNavGroup({
  collapsed,
  open,
  onToggle,
  isAdminPath,
  links,
  onNavigate,
}: {
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  isAdminPath: boolean;
  links: NavItem[];
  onNavigate?: () => void;
}) {
  if (collapsed) {
    return (
      <Link
        href="/admin"
        title="ניהול"
        aria-current={isAdminPath ? "page" : undefined}
        className={`flex items-center justify-center rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
          isAdminPath
            ? "bg-linear-to-b from-brand-500 to-brand-700 text-white shadow-brand"
            : "text-stone-600 hover:bg-bronze-50 hover:text-brand-800"
        }`}
      >
        <Icon name="chart" className={`w-5 h-5 shrink-0 ${isAdminPath ? "" : "text-bronze-500"}`} />
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors w-full ${
          isAdminPath ? "text-brand-800 bg-bronze-50/60" : "text-stone-600 hover:bg-bronze-50 hover:text-brand-800"
        }`}
      >
        <Icon name="chart" className={`w-5 h-5 shrink-0 ${isAdminPath ? "text-brand-600" : "text-bronze-500"}`} />
        <span className="flex-1 text-right truncate">ניהול</span>
        <Icon
          name="chevronRight"
          className={`w-4 h-4 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-1 pt-1 ps-4">
            {links.map((l) => (
              <NavLink key={l.href} link={l} collapsed={false} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthSection({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const initial = session?.user?.name?.trim().charAt(0) ?? "";

  if (status === "loading") return null;

  if (status === "authenticated") {
    return (
      <div className={`flex gap-2 ${collapsed ? "flex-col items-center" : "flex-col"}`}>
        <span
          className={`flex items-center gap-2 text-sm text-stone-600 ${
            collapsed ? "flex-col text-center" : ""
          }`}
        >
          <span className="w-9 h-9 rounded-full bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 font-bold flex items-center justify-center ring-1 ring-bronze-200 shadow-sm shrink-0">
            {initial}
          </span>
          {!collapsed && <span className="truncate">שלום, {session.user?.name}</span>}
        </span>
        <button
          onClick={() => {
            onNavigate?.();
            signOut({ callbackUrl: "/" });
          }}
          className={`btn btn-ghost btn-sm w-full ${collapsed ? "p-2!" : ""}`}
          title="התנתקות"
        >
          <Icon name="logout" className="w-4 h-4" />
          {!collapsed && "התנתקות"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Link
        href="/login"
        onClick={onNavigate}
        title={collapsed ? "התחברות" : undefined}
        className={`btn btn-sm w-full ${pathname === "/login" ? "btn-secondary" : "btn-ghost"} ${
          collapsed ? "p-2!" : ""
        }`}
      >
        {collapsed ? <Icon name="user" className="w-4 h-4" /> : "התחברות"}
      </Link>
      <Link
        href="/register"
        onClick={onNavigate}
        title={collapsed ? "הרשמה" : undefined}
        className={`btn btn-primary btn-sm w-full ${collapsed ? "p-2!" : ""}`}
      >
        {collapsed ? <Icon name="plus" className="w-4 h-4" /> : "הרשמה"}
      </Link>
    </div>
  );
}

export function Sidebar({
  children,
  showShifts = false,
  showFinance = false,
}: {
  children: ReactNode;
  showShifts?: boolean;
  showFinance?: boolean;
}) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [contactActive, setContactActive] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [adminOpenOverride, setAdminOpenOverride] = useState<boolean | null>(null);
  const [prevIsAdminPath, setPrevIsAdminPath] = useState(pathname?.startsWith("/admin") ?? false);

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
  const isAdminPath = pathname?.startsWith("/admin") ?? false;

  if (isAdminPath !== prevIsAdminPath) {
    setPrevIsAdminPath(isAdminPath);
    setAdminOpenOverride(null);
  }
  const adminOpen = adminOpenOverride ?? isAdminPath;

  const adminLinks: NavItem[] = [
    { href: "/admin", label: "לוח בקרה", icon: "chart", active: pathname === "/admin" },
    { href: "/admin/calendar", label: "יומן חדרים", icon: "calendar", active: pathname?.startsWith("/admin/calendar") ?? false },
    { href: "/admin/appointments", label: "ניהול תורים", icon: "list", active: pathname?.startsWith("/admin/appointments") ?? false },
    { href: "/admin/rooms", label: "חדרים", icon: "door", active: pathname?.startsWith("/admin/rooms") ?? false },
    { href: "/admin/gallery", label: "גלריה", icon: "image", active: pathname?.startsWith("/admin/gallery") ?? false },
    { href: "/admin/hours", label: "שעות פעילות", icon: "clock", active: pathname?.startsWith("/admin/hours") ?? false },
    { href: "/admin/users", label: "משתמשים", icon: "users", active: pathname?.startsWith("/admin/users") ?? false },
    ...(showShifts
      ? [{ href: "/admin/shifts", label: "משמרות", icon: "clock" as IconName, active: pathname?.startsWith("/admin/shifts") ?? false }]
      : []),
    ...(showFinance
      ? [{ href: "/admin/finance", label: "ניהול כספי", icon: "card" as IconName, active: pathname?.startsWith("/admin/finance") ?? false }]
      : []),
  ];

  const links: NavItem[] = [];

  if (!isAdmin && status !== "loading") {
    links.push(
      {
        href: "/",
        label: "דף הבית",
        icon: "home",
        active: pathname === "/" && !contactActive,
      },
      {
        href: "/gallery",
        label: "גלריה",
        icon: "image",
        active: pathname === "/gallery" && !contactActive,
      },
      {
        href: "/pricing",
        label: "מחירון",
        icon: "card",
        active: pathname === "/pricing" && !contactActive,
      },
      {
        href: "/booking",
        label: "הזמנת קליניקה",
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

  const homeHref = isAdmin ? "/admin" : "/";

  return (
    <>
      {/* סרגל עליון למובייל */}
      <header className="lg:hidden sticky top-0 z-30 bg-white/80 backdrop-blur-md shadow-[0_1px_0_rgb(221_211_196/0.6),0_8px_24px_-18px_rgb(35_48_45/0.25)]">
        <div className="flex items-center justify-between gap-4 px-4 sm:px-6 h-20 py-3">
          <Link href={homeHref} className="shrink-0">
            <Logo />
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="btn btn-ghost p-2!"
            aria-label="פתח תפריט"
            aria-expanded={drawerOpen}
          >
            <Icon name="menu" className="w-6 h-6" />
          </button>
        </div>
        <div aria-hidden="true" className="hairline-bronze" />
      </header>

      {/* תפריט נשלף למובייל */}
      <div
        className={`fixed inset-0 z-50 lg:hidden transition-opacity duration-300 ${
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <button
          type="button"
          aria-label="סגור תפריט"
          onClick={() => setDrawerOpen(false)}
          className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]"
        />
        <div
          className={`absolute inset-y-0 right-0 w-[82%] max-w-xs bg-white shadow-deep flex flex-col transition-transform duration-300 ${
            drawerOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between gap-2 px-4 py-5">
            <Link href={homeHref} onClick={() => setDrawerOpen(false)} className="shrink-0">
              <Logo />
            </Link>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="btn btn-ghost p-2!"
              aria-label="סגור תפריט"
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          </div>
          <div aria-hidden="true" className="hairline-bronze mx-4" />
          <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-1">
            {isAdmin ? (
              <AdminNavGroup
                collapsed={false}
                open={adminOpen}
                onToggle={() => setAdminOpenOverride(!adminOpen)}
                isAdminPath={isAdminPath}
                links={adminLinks}
                onNavigate={() => setDrawerOpen(false)}
              />
            ) : (
              links.map((l) => (
                <NavLink key={l.href} link={l} collapsed={false} onNavigate={() => setDrawerOpen(false)} />
              ))
            )}
          </nav>
          <div className="border-t border-cream-200/80 p-3">
            <AuthSection collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      </div>

      {/* פריסת שולחן עבודה: תפריט צדדי + תוכן */}
      <div className="lg:flex lg:min-h-screen">
        <aside
          className={`hidden lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-screen lg:shrink-0 lg:border-e border-cream-200/80 bg-white/80 backdrop-blur-md transition-[width] duration-300 ${
            collapsed ? "lg:w-20" : "lg:w-72"
          }`}
        >
          <div className={`flex items-center gap-2 px-4 py-5 ${collapsed ? "justify-center" : "justify-between"}`}>
            {!collapsed && (
              <Link href={homeHref} className="shrink-0">
                <Logo />
              </Link>
            )}
            {collapsed && (
              <Link href={homeHref} className="shrink-0">
                <LogoMark className="w-9 h-9" />
              </Link>
            )}
            {!collapsed && (
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                className="btn btn-ghost p-2! shrink-0"
                aria-label="כווץ תפריט"
              >
                <Icon name="chevronRight" className="w-5 h-5" />
              </button>
            )}
          </div>
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="btn btn-ghost p-2! mx-auto mb-2"
              aria-label="הרחב תפריט"
            >
              <Icon name="chevronLeft" className="w-5 h-5" />
            </button>
          )}
          <div aria-hidden="true" className="hairline-bronze mx-4" />
          <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-1">
            {isAdmin ? (
              <AdminNavGroup
                collapsed={collapsed}
                open={adminOpen}
                onToggle={() => setAdminOpenOverride(!adminOpen)}
                isAdminPath={isAdminPath}
                links={adminLinks}
              />
            ) : (
              links.map((l) => <NavLink key={l.href} link={l} collapsed={collapsed} />)
            )}
          </nav>
          <div className="border-t border-cream-200/80 p-3">
            <AuthSection collapsed={collapsed} />
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">{children}</div>
      </div>
    </>
  );
}
