"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/admin", label: "לוח בקרה", icon: "chart" },
  { href: "/admin/calendar", label: "יומן חדרים", icon: "calendar" },
  { href: "/admin/appointments", label: "ניהול תורים", icon: "list" },
  { href: "/admin/rooms", label: "חדרים", icon: "door" },
  { href: "/admin/users", label: "משתמשים", icon: "users" },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="ניווט ניהול"
      className="card p-2 lg:p-3 flex lg:flex-col gap-1 overflow-x-auto lg:sticky lg:top-28"
    >
      {TABS.map((tab) => {
        const active = tab.href === "/admin" ? pathname === "/admin" : pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
              active
                ? "bg-linear-to-b from-brand-500 to-brand-700 text-white shadow-brand"
                : "text-stone-600 hover:bg-bronze-50 hover:text-brand-800"
            }`}
          >
            <Icon name={tab.icon} className={`w-5 h-5 shrink-0 ${active ? "" : "text-bronze-500"}`} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
