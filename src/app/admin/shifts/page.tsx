import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { AdminShifts } from "@/components/shifts/admin-shifts";
import { getShiftsProvider } from "@/lib/shifts/gate";
import { ShiftWindowsProvider } from "@/components/shifts/windows-provider";
import { listShiftWindows } from "@/lib/shifts/windows-db";

// השער נקרא ממשתני סביבה בזמן ריצה. הגישה למנהלים נאכפת ע"י ה-proxy וע"י בדיקת התפקיד בכל נתיב API
export const dynamic = "force-dynamic";

export default async function AdminShiftsPage() {
  if (!getShiftsProvider()) notFound();
  const windows = await listShiftWindows();
  return (
    <div>
      <PageHeader eyebrow="ניהול" title="משמרות קבועות" subtitle="משמרות, בקשות, זכאות וחיוב חודשי" />
      <ShiftWindowsProvider windows={windows}>
        <AdminShifts />
      </ShiftWindowsProvider>
    </div>
  );
}
