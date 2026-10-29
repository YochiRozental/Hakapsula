import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Icon, PageHeader } from "@/components/ui";
import { getFlowProvider } from "@/lib/payments/flow";
import { isIvrPinSetupEnabled } from "@/lib/ivr-pin/flag";
import { isMockCardEnabled } from "@/lib/payments/mock-card-flag";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { getShiftsProvider } from "@/lib/shifts/gate";
import { UserCard } from "@/components/user-card";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile");
  if (session.user.role === "ADMIN") redirect("/admin");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      appointments: {
        orderBy: { startTime: "desc" },
        include: { room: { select: { key: true, name: true } } },
      },
    },
  });
  if (!user) redirect("/login");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        eyebrow="האזור האישי"
        title="כרטיס הלקוח שלי"
        actions={
          <Link href="/complete-profile?edit=1&next=/profile" className="btn btn-primary btn-sm">
            עריכת פרטים
          </Link>
        }
      />
      {/* אמצעי תשלום מדומה לבדיקות: מוצג רק כשהדגל פתוח והספק הוא Mock בסביבת sandbox */}
      {isMockCardEnabled() && getFlowProvider() instanceof MockPaymentProvider && (
        <Link href="/profile/payment-method" className="card card-hover flex items-center gap-4 p-5 mb-6">
          <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
            <Icon name="card" className="w-5 h-5" />
          </span>
          <span className="flex-1">
            <span className="block font-display font-bold text-stone-900">אמצעי תשלום (מדומה)</span>
            <span className="block text-sm text-stone-500">שמירת כרטיס מדומה לבדיקת תשלום בטלפון</span>
          </span>
          <Icon name="chevronLeft" className="w-5 h-5 text-stone-400" />
        </Link>
      )}
      {/* הגדרת קוד טלפוני: מוצגת רק כשהשער IVR_PIN_SETUP_ENABLED פתוח */}
      {isIvrPinSetupEnabled() && (
        <Link href="/profile/ivr-pin" className="card card-hover flex items-center gap-4 p-5 mb-6">
          <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
            <Icon name="lock" className="w-5 h-5" />
          </span>
          <span className="flex-1">
            <span className="block font-display font-bold text-stone-900">קוד טלפוני</span>
            <span className="block text-sm text-stone-500">הגדרה או שינוי של קוד הזיהוי לשיחות טלפון</span>
          </span>
          <Icon name="chevronLeft" className="w-5 h-5 text-stone-400" />
        </Link>
      )}
      {/* כניסה ליתרת שעות וחבילות: מוצגת רק כשזרימת התשלום פעילה (סביבת פיתוח); באתר החי אינה מופיעה */}
      {getFlowProvider() && (
        <Link href="/profile/hours" className="card card-hover flex items-center gap-4 p-5 mb-6">
          <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
            <Icon name="clock" className="w-5 h-5" />
          </span>
          <span className="flex-1">
            <span className="block font-display font-bold text-stone-900">חבילות שעות ויתרה</span>
            <span className="block text-sm text-stone-500">יתרת הדקות שלכם, רכישת חבילות והיסטוריית תשלומים</span>
          </span>
          <Icon name="chevronLeft" className="w-5 h-5 text-stone-400" />
        </Link>
      )}
      {/* משמרות קבועות: מוצגות רק כשהשער SHIFTS_ENABLED פתוח (סביבת פיתוח עם ספק Mock) */}
      {getShiftsProvider() && (
        <Link href="/profile/shifts" className="card card-hover flex items-center gap-4 p-5 mb-6">
          <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
            <Icon name="calendar" className="w-5 h-5" />
          </span>
          <span className="flex-1">
            <span className="block font-display font-bold text-stone-900">המשמרות שלי</span>
            <span className="block text-sm text-stone-500">משמרות קבועות, חיוב חודשי ובקשות שינוי וביטול</span>
          </span>
          <Icon name="chevronLeft" className="w-5 h-5 text-stone-400" />
        </Link>
      )}
      {/* eslint-disable-next-line react-hooks/purity -- server component, rendered once per request */}
      <UserCard user={user} now={Date.now()} />
    </div>
  );
}
