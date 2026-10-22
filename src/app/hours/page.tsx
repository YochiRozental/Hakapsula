import Link from "next/link";
import { BrandHeader, Icon } from "@/components/ui";
import { DayHours } from "@/components/hours-summary";
import { loadWindows } from "@/lib/opening-hours-db";
import { isClosedDate, jerusalemParts, OPEN_WEEKDAYS, resolveDay, weeklyDay, WEEKDAY_LABELS } from "@/lib/opening-hours";

export const dynamic = "force-dynamic";

const UPCOMING_DAYS = 60;

export default async function HoursPage() {
  const windows = await loadWindows();
  const now = new Date();
  const todayKey = jerusalemParts(now).date;
  const limitKey = jerusalemParts(new Date(now.getTime() + UPCOMING_DAYS * 86_400_000)).date;

  // תאריכי חריגים עתידיים בלבד (לא שבת), לפי סדר כרונולוגי
  const exceptionDates = [...new Set(windows.filter((w) => w.date).map((w) => w.date as string))]
    .filter((d) => d >= todayKey && d <= limitKey && !isClosedDate(d))
    .sort();

  return (
    <div className="max-w-5xl mx-auto">
      <BrandHeader eyebrow="שעות פעילות" title="מתי אנחנו פתוחים" subtitle="שעות הפעילות השבועיות — זהות לכל החדרים">
        <Link href="/booking" className="btn btn-bronze">
          קביעת תור
          <Icon name="arrowLeft" className="w-4 h-4" />
        </Link>
      </BrandHeader>

      <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {OPEN_WEEKDAYS.map((weekday) => {
          const label = WEEKDAY_LABELS[weekday];
          return (
            <div key={label} className="card p-5">
              <h2 className="font-display text-lg font-bold text-stone-900 mb-3">יום {label}</h2>
              <DayHours day={weeklyDay(windows, weekday)} />
            </div>
          );
        })}
      </section>

      {exceptionDates.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-2xl font-bold text-stone-900 mb-4">שינויים בתאריכים מסוימים</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {exceptionDates.map((d) => (
              <div key={d} className="card p-5 ring-1 ring-bronze-200">
                <h3 className="font-bold text-stone-900 mb-3">
                  {new Date(`${d}T00:00:00`).toLocaleDateString("he-IL", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </h3>
                <DayHours day={resolveDay(windows, d)} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
