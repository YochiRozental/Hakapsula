import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { HoursCenter } from "@/components/payments/hours-center";
import { getFlowProvider } from "@/lib/payments/flow";

/**
 * יתרת שעות, רכישת חבילות והיסטוריית תשלומים. חלק מ"הכרטיס שלי". קיים רק כשזרימת התשלום פעילה (סביבת פיתוח);
 * בכל סביבה אחרת 404. הנתונים עצמם נטענים מהשרת ב-API ומוגבלים למשתמש המחובר.
 */
// השער נקרא ממשתני סביבה בזמן ריצה, ולכן העמוד אסור שיוכן מראש בזמן build (אחרת ייקבע 404 לצמיתות)
export const dynamic = "force-dynamic";

export default async function HoursPage() {
  if (!getFlowProvider()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile/hours");
  if (session.user.role === "ADMIN") redirect("/admin");

  // הרשאת הרכישה נקבעת לפי המסד ולא לפי ה-session; השרת אוכף אותה שוב בכל רכישה
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { status: true, role: true } });
  if (!user) redirect("/login");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader eyebrow="האזור האישי" title="חבילות שעות ויתרה" subtitle="יתרת הדקות שלכם, רכישת חבילות והיסטוריית תשלומים" />
      <HoursCenter canPurchase={user.status === "APPROVED" && user.role === "CLIENT"} />
    </div>
  );
}
