import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { FinanceAdmin } from "@/components/finance/finance-admin";
import { getFinanceProvider } from "@/lib/finance/gate";

// השער נקרא ממשתני סביבה בזמן ריצה. הגישה למנהלים נאכפת ע"י ה-proxy וע"י בדיקת התפקיד בכל נתיב API
export const dynamic = "force-dynamic";

export default function AdminFinancePage() {
  if (!getFinanceProvider()) notFound();
  return (
    <div>
      <PageHeader eyebrow="ניהול" title="ניהול כספי" subtitle="תשלומים, חובות, החזרים, ביטול חבילות ותור בירור" />
      <FinanceAdmin />
    </div>
  );
}
