import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Icon } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export default async function AccountStatusPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // הסטטוס נקרא ממסד הנתונים: ה-session (JWT) עלול להיות ישן אחרי אישור/חסימה של מנהל
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { status: true },
  });
  if (!user) redirect("/login");
  if (user.status === "APPROVED") redirect("/booking");

  const isBlocked = user.status === "BLOCKED";

  return (
    <div className="max-w-lg mx-auto card shadow-deep! relative overflow-hidden p-8 sm:p-12 text-center">
      <span
        aria-hidden="true"
        className="absolute top-0 inset-x-10 hairline-bronze"
      />
      <span
        className={`mx-auto mb-5 w-16 h-16 rounded-full flex items-center justify-center ${
          isBlocked
            ? "bg-red-50 text-red-600 ring-1 ring-red-100"
            : "bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-600 ring-1 ring-bronze-200"
        }`}
      >
        <Icon name={isBlocked ? "ban" : "hourglass"} className="w-8 h-8" />
      </span>
      <span
        className={`badge mb-3 ${isBlocked ? "bg-red-50 text-red-700" : "bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200"}`}
      >
        {isBlocked ? "חסום" : "ממתין לאישור"}
      </span>
      <h1 className="font-display text-3xl font-bold text-stone-900 mb-3">
        {isBlocked ? "החשבון שלך חסום" : "ההרשמה שלך התקבלה"}
      </h1>
      {isBlocked ? (
        <p className="text-stone-600 leading-relaxed">
          החשבון שלך נחסם על ידי מנהל המערכת ולא ניתן לקבוע דרכו תורים כרגע.
          לבירור יש ליצור קשר עם מנהל המערכת.
        </p>
      ) : (
        <p className="text-stone-600 leading-relaxed">
          החשבון שלך ממתין לאישור מנהל המערכת. תגובה עד 24 שעות. לאחר האישור
          תקבל/י הודעה (במייל או בשיחת טלפון, בהתאם לאופן ההרשמה) ותוכל/י להתחיל
          לקבוע תורים.
        </p>
      )}
    </div>
  );
}
