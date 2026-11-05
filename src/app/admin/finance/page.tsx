import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { FinanceAdmin } from "@/components/finance/finance-admin";
import { getFinanceProvider } from "@/lib/finance/gate";
import { ShiftWindowsProvider } from "@/components/shifts/windows-provider";
import { listShiftWindows } from "@/lib/shifts/windows-db";

// השער נקרא ממשתני סביבה בזמן ריצה. הגישה למנהלים נאכפת ע"י ה-proxy וע"י בדיקת התפקיד בכל נתיב API
export const dynamic = "force-dynamic";

export default async function AdminFinancePage() {
  if (!getFinanceProvider()) notFound();
  const windows = await listShiftWindows();
  return (
    <div>
      <PageHeader eyebrow="ניהול" title="ניהול כספי" subtitle="תשלומים, חובות, החזרים, ביטול חבילות ותור בירור" />
      <ShiftWindowsProvider windows={windows}>
        <FinanceAdmin />
      </ShiftWindowsProvider>
    </div>
  );
}
