import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { AdminShifts } from "@/components/shifts/admin-shifts";
import { getShiftsProvider } from "@/lib/shifts/gate";

// השער נקרא ממשתני סביבה בזמן ריצה. הגישה למנהלים נאכפת ע"י ה-proxy וע"י בדיקת התפקיד בכל נתיב API
export const dynamic = "force-dynamic";

export default function AdminShiftsPage() {
  if (!getShiftsProvider()) notFound();
  return (
    <div>
      <PageHeader eyebrow="ניהול" title="משמרות קבועות" subtitle="משמרות, בקשות, זכאות וחיוב חודשי" />
      <AdminShifts />
    </div>
  );
}
