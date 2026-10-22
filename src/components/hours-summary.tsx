import { ACTIVITY_LABELS, formatWindow, type ActivityType, type ResolvedDay } from "@/lib/opening-hours";

/** צבע + נקודה + שם המסלול בטקסט (הצבע אינו האמצעי היחיד להבחנה). ניגודיות גבוהה: טקסט כהה על רקע בהיר */
const ACTIVITY_BADGE: Record<ActivityType, { badge: string; dot: string }> = {
  BOYS: { badge: "bg-sky-50 text-sky-900 ring-1 ring-sky-300", dot: "bg-sky-600" },
  GIRLS: { badge: "bg-rose-50 text-rose-900 ring-1 ring-rose-300", dot: "bg-rose-600" },
};

export function ActivityBadge({ activity }: { activity: ActivityType }) {
  const style = ACTIVITY_BADGE[activity];
  return (
    <span className={`badge ${style.badge}`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${style.dot}`} />
      {ACTIVITY_LABELS[activity]}
    </span>
  );
}

/** תצוגת שעות של יום אחד, עם סוג הפעילות בכל חלון — משמשת את הדף הציבורי ואת הניהול */
export function DayHours({ day }: { day: ResolvedDay }) {
  if (day.closed) {
    return <p className="text-sm font-semibold text-red-600">סגור{day.note ? ` · ${day.note}` : ""}</p>;
  }
  return (
    <div className="space-y-2">
      {day.windows.length === 0 ? (
        <p className="text-sm text-stone-400">אין פעילות</p>
      ) : (
        <ul className="space-y-1.5">
          {day.windows.map((w, i) => (
            <li key={i} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-semibold tabular-nums text-stone-800">
                <span dir="ltr" className="inline-block">
                  {formatWindow(w)}
                </span>
              </span>
              <ActivityBadge activity={w.activity} />
            </li>
          ))}
        </ul>
      )}
      {day.note && <p className="text-xs text-bronze-700">{day.note}</p>}
    </div>
  );
}
