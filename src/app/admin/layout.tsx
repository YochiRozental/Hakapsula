import type { ReactNode } from "react";
import { AdminTabs } from "@/components/admin-tabs";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid lg:grid-cols-[230px_1fr] gap-6 items-start">
      <aside className="min-w-0">
        <div className="hidden lg:block panel-brand rounded-[1.25rem] px-5 py-5 mb-3">
          <p className="text-[11px] font-bold tracking-[0.14em] text-bronze-300">אזור ניהול</p>
          <p className="font-display text-xl font-bold mt-1">מערכת הקליניקות</p>
        </div>
        <AdminTabs />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
