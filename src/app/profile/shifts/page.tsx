import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { ShiftsCenter } from "@/components/shifts/shifts-center";
import { isMockCardEnabled } from "@/lib/payments/mock-card-flag";
import { getShiftsProvider } from "@/lib/shifts/gate";

// השער נקרא ממשתני סביבה בזמן ריצה: אסור להכין את העמוד מראש בזמן build
export const dynamic = "force-dynamic";

/** "המשמרות שלי". קיים רק כשהשער פתוח (SHIFTS_ENABLED + ספק Mock בסביבת פיתוח); אחרת 404. הנתונים נטענים מהשרת וממוקדים במשתמש */
export default async function ShiftsPage() {
  if (!getShiftsProvider()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile/shifts");
  if (session.user.role === "ADMIN") redirect("/admin/shifts");
  if (session.user.mustChangePassword) redirect("/change-password");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader eyebrow="האזור האישי" title="המשמרות שלי" subtitle="משמרות קבועות, חיוב חודשי ובקשות שינוי וביטול" />
      <ShiftsCenter mockCardLink={isMockCardEnabled()} />
    </div>
  );
}
