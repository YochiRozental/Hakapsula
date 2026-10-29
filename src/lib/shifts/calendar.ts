import { jerusalemWallInstant } from "@/lib/jerusalem-time";
import {
  SHIFT_WINDOWS,
  findShiftWindow,
  shiftSessionPriceAgorot,
  shiftWindowMinutes,
  type ShiftWindowId,
} from "@/lib/payments/pricing";

/**
 * חישובי לוח שנה של משמרות קבועות. פונקציות טהורות (בלי מסד נתונים), על תאריכי YYYY-MM-DD של ירושלים.
 *
 * כלל התקופה (החלטה מתועדת): משמרת תקפה לשלושה חודשים קלנדריים, והחודש שבו היא מתחילה הוא הראשון. תאריך הסיום הוא
 * היום האחרון של החודש השלישי. התחלה באמצע חודש משמעה חודש ראשון חלקי: למשל התחלה ב-15.1 מסתיימת ב-31.3. כך יש בדיוק
 * שלושה חודשי חיוב, החיוב הראשון כולל רק את המופעים שנותרו באותו חודש, ואין אף מופע אחרי סוף החודש השלישי.
 */

export const SHIFT_PERIOD_MONTHS = 3;

/** כמה ימים קדימה מותר לבחור תאריך התחלה. שמרני בכוונה: לא נועלים חדרים לחודשים מראש */
export const MAX_START_AHEAD_DAYS = 31;

/** ימי שבוע ששייכים למשמרת: ראשון עד שישי. שבת סגורה */
export const SHIFT_WEEKDAYS = [0, 1, 2, 3, 4, 5] as const;

export type { ShiftWindowId };
export { SHIFT_WINDOWS };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = ISO.exec(iso);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function mustParse(iso: string) {
  const p = parseIso(iso);
  if (!p) throw new RangeError(`תאריך לא תקין: ${iso}`);
  return p;
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = mustParse(iso);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 0 = ראשון ... 6 = שבת (כמו בשאר המערכת). אינו תלוי באזור הזמן של השרת */
export function weekdayOf(iso: string): number {
  const { y, m, d } = mustParse(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const monthKeyOf = (iso: string) => iso.slice(0, 7);

/** היום האחרון של חודש קלנדרי */
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** הסיום: היום האחרון של החודש השלישי (החודש שבו מתחילים נספר כראשון) */
export function shiftEndDate(startIso: string): string {
  const { y, m } = mustParse(startIso);
  const endMonthIndex = m - 1 + (SHIFT_PERIOD_MONTHS - 1);
  const endYear = y + Math.floor(endMonthIndex / 12);
  const endMonth = (endMonthIndex % 12) + 1;
  return isoOf(endYear, endMonth, lastDayOfMonth(endYear, endMonth));
}

/** שלושת מפתחות חודשי החיוב של המשמרת, לפי הסדר */
export function billingMonths(startIso: string): string[] {
  const { y, m } = mustParse(startIso);
  return Array.from({ length: SHIFT_PERIOD_MONTHS }, (_, i) => {
    const idx = m - 1 + i;
    return `${y + Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
  });
}

/** כל התאריכים בין fromIso ל-toIso (כולל) שחלים ביום השבוע הנתון. בלי כפילויות ולפי הסדר */
export function occurrenceDatesBetween(fromIso: string, toIso: string, weekday: number): string[] {
  if (!SHIFT_WEEKDAYS.includes(weekday as (typeof SHIFT_WEEKDAYS)[number])) throw new RangeError("יום שבוע לא תקין למשמרת");
  const dates: string[] = [];
  const offset = (weekday - weekdayOf(fromIso) + 7) % 7;
  for (let cursor = addDays(fromIso, offset); cursor <= toIso; cursor = addDays(cursor, 7)) dates.push(cursor);
  return dates;
}

/** כל התאריכים בין startIso לסוף התקופה (כולל) שחלים ביום השבוע הנתון. ולעולם לא אחרי הסיום */
export function occurrenceDates(startIso: string, weekday: number): string[] {
  return occurrenceDatesBetween(startIso, shiftEndDate(startIso), weekday);
}

/** היום הראשון של חודש (YYYY-MM -> YYYY-MM-01) */
export const monthStartIso = (month: string) => `${month}-01`;

export function groupByMonth<T extends { date: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = monthKeyOf(item.date);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

/** תחילה וסיום של מופע (רגעים אמיתיים), לפי שעון ירושלים, כולל ימי מעבר שעון */
export function occurrenceTimes(dateIso: string, windowId: ShiftWindowId): { startTime: Date; endTime: Date } {
  const w = findShiftWindow(windowId);
  if (!w) throw new RangeError("משבצת לא קיימת");
  return { startTime: jerusalemWallInstant(dateIso, w.startMinutes), endTime: jerusalemWallInstant(dateIso, w.endMinutes) };
}

export function isShiftWindowId(value: unknown): value is ShiftWindowId {
  return typeof value === "string" && SHIFT_WINDOWS.some((w) => w.id === value);
}

/** מחיר מופע באגורות (שעה = 41.60 ₪, מחושב לפי המשך בפועל של המשבצת) */
export function occurrencePriceAgorot(windowId: ShiftWindowId): number {
  return shiftSessionPriceAgorot(shiftWindowMinutes(windowId));
}

/** החיוב החודשי: מספר המופעים בפועל באותו חודש כפול מחיר מופע (מספרים שלמים בלבד) */
export function monthAmountAgorot(windowId: ShiftWindowId, occurrences: number): number {
  if (!Number.isInteger(occurrences) || occurrences < 0) throw new RangeError("מספר מופעים לא תקין");
  return occurrences * occurrencePriceAgorot(windowId);
}

/** תאריך התחלה תקין: פורמט, לא בעבר (לפי היום בירושלים), ולא רחוק מדי קדימה. מחזיר הודעת שגיאה או null */
export function validateStartDate(startIso: string, todayIso: string): string | null {
  if (!parseIso(startIso)) return "תאריך התחלה לא תקין";
  if (startIso < todayIso) return "תאריך ההתחלה לא יכול להיות בעבר";
  if (startIso > addDays(todayIso, MAX_START_AHEAD_DAYS)) return `ניתן לבחור תאריך התחלה עד ${MAX_START_AHEAD_DAYS} ימים קדימה`;
  return null;
}
