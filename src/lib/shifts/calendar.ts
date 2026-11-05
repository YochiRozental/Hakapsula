import { jerusalemWallInstant } from "@/lib/jerusalem-time";

/**
 * חישובי לוח שנה של משמרות קבועות. פונקציות טהורות (בלי מסד נתונים), על תאריכי YYYY-MM-DD של ירושלים.
 *
 * כלל התקופה (החלטה עסקית סופית): משמרת נמשכת שלושה חודשים מתאריך תחילתה, ומסתיימת ביום שלפני מועד החיוב הרביעי
 * (למשל התחלה ב-15.2 מסתיימת ב-14.5). אין חידוש. יש בדיוק שלושה חיובים: בתאריך ההתחלה, חודש אחריו וחודשיים אחריו, כל
 * מועד מחושב ביחס לתאריך ההתחלה המקורי (31.1 -> 28.2 -> 31.3). אין חישוב יחסי: כל המפגשים בתקופה כלולים במחיר החודשי הקבוע.
 */

export const SHIFT_PERIOD_MONTHS = 3;

/** כמה ימים קדימה מותר לבחור תאריך התחלה. שמרני בכוונה: לא נועלים חדרים לחודשים מראש */
export const MAX_START_AHEAD_DAYS = 31;

/** ימי שבוע ששייכים למשמרת: ראשון עד שישי. שבת סגורה */
export const SHIFT_WEEKDAYS = [0, 1, 2, 3, 4, 5] as const;

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

/**
 * מוסיף חודשים קלנדריים לתאריך. אם היום אינו קיים בחודש היעד (למשל 31 בחודש קצר) התוצאה היא היום האחרון של אותו חודש.
 * תמיד מחשבים ביחס לתאריך ההתחלה המקורי ולא בשרשרת (31.1 -> 28.2 -> 31.3, ולא 28.2 -> 28.3).
 */
export function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = mustParse(iso);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12 + 1;
  return isoOf(year, month, Math.min(d, lastDayOfMonth(year, month)));
}

/** סיום המשמרת: היום שלפני מועד החיוב הרביעי (תאריך ההתחלה + שלושה חודשים). לא מתחדשת ולא מחויבת אחריו */
export function shiftEndDate(startIso: string): string {
  return addDays(addMonthsClamped(startIso, SHIFT_PERIOD_MONTHS), -1);
}

/** שלושת מועדי החיוב: תאריך ההתחלה, חודש אחריו, וחודשיים אחריו (כל אחד ביחס לתאריך ההתחלה המקורי). אין חיוב רביעי */
export function billingDueDates(startIso: string): string[] {
  return Array.from({ length: SHIFT_PERIOD_MONTHS }, (_, i) => addMonthsClamped(startIso, i));
}

/** שלושת מפתחות החיוב (YYYY-MM של מועד החיוב), לפי הסדר. חודשי מועדי החיוב תמיד שונים זה מזה */
export function billingMonths(startIso: string): string[] {
  return billingDueDates(startIso).map(monthKeyOf);
}

/** באיזו תקופת חיוב (0, 1 או 2) חל תאריך: התקופה שמתחילה במועד החיוב האחרון שאינו אחרי התאריך */
export function periodIndexOf(startIso: string, dateIso: string): number {
  const due = billingDueDates(startIso);
  let index = 0;
  for (let i = 0; i < due.length; i++) if (dateIso >= due[i]) index = i;
  return index;
}

/** מפתח החיוב (YYYY-MM) של תקופת החיוב שבה חל התאריך */
export function periodKeyOf(startIso: string, dateIso: string): string {
  return billingMonths(startIso)[periodIndexOf(startIso, dateIso)];
}

/** כמה מפגשים (ביום השבוע הנתון) יש בתקופת חיוב שלמה, לפי הלוח האמיתי. תמיד 4 או 5 */
export function sessionsInPeriod(startIso: string, weekday: number, index: number): number {
  const due = billingDueDates(startIso);
  const from = due[index];
  const to = index + 1 < due.length ? addDays(due[index + 1], -1) : shiftEndDate(startIso);
  return occurrenceDatesBetween(from, to, weekday).length;
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

export function groupByMonth<T extends { date: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = monthKeyOf(item.date);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

/** תחילה וסיום של מופע (רגעים אמיתיים), לפי שעון ירושלים, כולל ימי מעבר שעון */
export function occurrenceTimes(dateIso: string, window: { startMinutes: number; endMinutes: number }): { startTime: Date; endTime: Date } {
  return { startTime: jerusalemWallInstant(dateIso, window.startMinutes), endTime: jerusalemWallInstant(dateIso, window.endMinutes) };
}

/**
 * מחיר מופע (אגורות) = המחיר החודשי ÷ מספר המפגשים בתקופת החיוב שבה חל המופע (4 או 5). המחיר החודשי הוא בשקלים שלמים,
 * ולכן החלוקה מדויקת באגורות והתקופה מסתכמת תמיד במחיר החודשי. המחיר אינו משמש לחיוב (החיוב הוא תמיד המחיר החודשי הקבוע)
 * אלא רק להחזר חלקי שמנהל אישר במפורש (ביטול מאושר).
 */
export function occurrencePriceAgorot(monthlyPriceAgorot: number, startIso: string, weekday: number, dateIso: string): number {
  if (!Number.isInteger(monthlyPriceAgorot) || monthlyPriceAgorot < 0) throw new RangeError("מחיר חודשי לא תקין");
  const count = sessionsInPeriod(startIso, weekday, periodIndexOf(startIso, dateIso));
  return count === 0 ? 0 : Math.round(monthlyPriceAgorot / count);
}

/** תאריך התחלה תקין: פורמט, לא בעבר (לפי היום בירושלים), ולא רחוק מדי קדימה. מחזיר הודעת שגיאה או null */
export function validateStartDate(startIso: string, todayIso: string): string | null {
  if (!parseIso(startIso)) return "תאריך התחלה לא תקין";
  if (startIso < todayIso) return "תאריך ההתחלה לא יכול להיות בעבר";
  if (startIso > addDays(todayIso, MAX_START_AHEAD_DAYS)) return `ניתן לבחור תאריך התחלה עד ${MAX_START_AHEAD_DAYS} ימים קדימה`;
  return null;
}
