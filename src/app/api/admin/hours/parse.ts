import { isActivityType, type DayInterval } from "@/lib/opening-hours";

/** קלט גולמי מה-API -> חלונות מוקלדים, או null אם המבנה שגוי (תוכן השעות נבדק ב-validateWindows) */
export function parseWindowsBody(raw: unknown): DayInterval[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DayInterval[] = [];
  for (const w of raw) {
    if (!w || typeof w.startMinutes !== "number" || typeof w.endMinutes !== "number" || !isActivityType(w.activity)) {
      return null;
    }
    out.push({ startMinutes: w.startMinutes, endMinutes: w.endMinutes, activity: w.activity });
  }
  return out;
}
