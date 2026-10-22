/** לוגיקה טהורה (ללא גישה למסד) של שעות הפעילות — משותפת לשרת ולדפדפן. לוח אחד לכל החדרים */

/** מסלולי פעילות: לוח שעות משותף אחד לכל החדרים, וכל חלון שייך לאחד המסלולים */
export const ACTIVITY_TYPES = ["BOYS", "GIRLS"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  BOYS: "בנים",
  GIRLS: "בנות",
};

/** מסלול ברירת המחדל לכל יום בשבוע (0 = ראשון): ראשון, שלישי וחמישי — בנות; שני, רביעי ושישי — בנים */
export const DEFAULT_WEEKDAY_ACTIVITY: Record<number, ActivityType> = {
  0: "GIRLS",
  1: "BOYS",
  2: "GIRLS",
  3: "BOYS",
  4: "GIRLS",
  5: "BOYS",
};

/** מסלול ההזמנה של משתמש נקבע לפי המגדר שלו (גבר — בנים, אישה — בנות); אורח שאינו מחובר יכול רק לעיין בכל מסלול */
export type BookingTrack = ActivityType;

export function trackForGender(gender: "MALE" | "FEMALE" | null | undefined): BookingTrack | undefined {
  return gender === "MALE" ? "BOYS" : gender === "FEMALE" ? "GIRLS" : undefined;
}

export function isActivityType(v: unknown): v is ActivityType {
  return (ACTIVITY_TYPES as readonly unknown[]).includes(v);
}

/** בלי מסלול (undefined) כל חלון מתאים — לתצוגה בלבד (אורח שמעיין בלוח), לא לאכיפת הזמנה */
export function activityMatches(activity: ActivityType, track?: BookingTrack): boolean {
  return !track || activity === track;
}

/** שעות היום המלא כשלא הוגדרו חלונות מפורשים: 08:00–21:00, במסלול ברירת המחדל של היום */
export const DEFAULT_DAY_WINDOW = { startMinutes: 8 * 60, endMinutes: 21 * 60 };

export type HoursWindow = {
  id?: string;
  /** 0 = ראשון ... 6 = שבת; null בחריגים לתאריך */
  weekday: number | null;
  /** YYYY-MM-DD בחריגים; null בברירת מחדל שבועית */
  date: string | null;
  startMinutes: number;
  endMinutes: number;
  closed: boolean;
  activity: ActivityType;
  note?: string | null;
  /** שורת "מסלול היום" של יום שבועי (ברירת מחדל 08:00–21:00): נשמרת כדי לזכור את בחירת המסלול ליום גם בלי חלונות מפורשים */
  dayDefault?: boolean;
};

export type DayInterval = { startMinutes: number; endMinutes: number; activity: ActivityType };

export type ResolvedDay = {
  source: "exception" | "weekly";
  closed: boolean;
  note: string | null;
  /** חלונות ממוינים; חלונות צמודים מאותו סוג מאוחדים */
  windows: DayInterval[];
};

export const WEEKDAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
/** ימי שבוע שבהם המכון פתוח (0 = ראשון ... 5 = שישי). שבת סגורה תמיד — גם חריג לתאריך לא יכול לפתוח אותה */
export const OPEN_WEEKDAYS = [0, 1, 2, 3, 4, 5];
export const STEP_MINUTES = 5;
const MAX_WINDOWS_PER_SCOPE = 12;

/** "HH:mm" -> דקות מתחילת היום */
export function parseTimeOption(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function formatMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function parseDateKey(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
    ? d
    : null;
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const jerusalemFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});
const JERUSALEM_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * תאריך (YYYY-MM-DD), דקות מתחילת היום ויום בשבוע (0 = ראשון) של רגע נתון לפי שעון ירושלים.
 * כל אכיפת הלוח בשרת עוברת כאן, כדי שלא תהיה תלות באזור הזמן של השרת.
 */
export function jerusalemParts(d: Date): { date: string; minutes: number; weekday: number } {
  const p = Object.fromEntries(jerusalemFormat.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: JERUSALEM_WEEKDAYS.indexOf(p.weekday),
  };
}

/** מאחד טווחים צמודים/חופפים (עם אותו סוג פעילות, או בלי התחשבות בסוג) כך שהזמנה יכולה להימשך על פני חלונות רצופים */
function mergeIntervals(list: DayInterval[], sameActivityOnly = true): DayInterval[] {
  const sorted = list
    .map((w) => ({ startMinutes: w.startMinutes, endMinutes: w.endMinutes, activity: w.activity }))
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const out: DayInterval[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && (!sameActivityOnly || last.activity === w.activity) && w.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, w.endMinutes);
    } else out.push(w);
  }
  return out;
}

/** החלונות המפורשים של יום בשבוע (ללא חריגים וללא שורת "מסלול היום") */
export function weeklyWindows(all: HoursWindow[], weekday: number): HoursWindow[] {
  return all.filter((w) => w.date === null && w.weekday === weekday && !w.closed && !w.dayDefault);
}

/** האם יום בשבוע הוגדר כסגור קבוע (שורת "מסלול היום" עם closed). חלונות מפורשים אינם פותחים יום כזה */
export function weeklyDayClosed(all: HoursWindow[], weekday: number): boolean {
  return all.some((w) => w.date === null && w.weekday === weekday && w.dayDefault && w.closed);
}

/** מסלול היום השבועי: מה שנשמר בניהול, ואם לא נשמר — ברירת המחדל לפי היום בשבוע */
export function weeklyDefaultActivity(all: HoursWindow[], weekday: number): ActivityType {
  const saved = all.find((w) => w.date === null && w.weekday === weekday && w.dayDefault);
  return saved?.activity ?? DEFAULT_WEEKDAY_ACTIVITY[weekday] ?? "BOYS";
}

export function isClosedWeekday(weekday: number): boolean {
  return !OPEN_WEEKDAYS.includes(weekday);
}

/** האם התאריך (YYYY-MM-DD) חל ביום סגור קבוע (שבת)? תאריך לא תקין נחשב סגור */
export function isClosedDate(dateStr: string): boolean {
  return isClosedWeekday(parseDateKey(dateStr)?.getDay() ?? -1);
}

/** שעות ברירת המחדל השבועית של יום בשבוע, בפורמט של יום מפוענח */
export function weeklyDay(all: HoursWindow[], weekday: number): ResolvedDay {
  if (weeklyDayClosed(all, weekday)) return { source: "weekly", closed: true, note: null, windows: [] };
  const explicit = weeklyWindows(all, weekday);
  // חלונות מפורשים גוברים על ברירת המחדל (אין פעילות כפולה); בלעדיהם — היום המלא במסלול היום
  const windows =
    explicit.length > 0
      ? mergeIntervals(explicit)
      : [{ ...DEFAULT_DAY_WINDOW, activity: weeklyDefaultActivity(all, weekday) }];
  return { source: "weekly", closed: false, note: null, windows };
}

/** חריג לתאריך (אם קיים) דורס לגמרי את ברירת המחדל השבועית של אותו יום. יום סגור קבוע (שבת) גובר על הכול */
export function resolveDay(all: HoursWindow[], dateStr: string): ResolvedDay {
  if (isClosedDate(dateStr)) {
    return { source: "weekly", closed: true, note: "יום שבת", windows: [] };
  }
  const exception = all.filter((w) => w.date === dateStr);
  if (exception.length > 0) {
    const closed = exception.some((w) => w.closed);
    return {
      source: "exception",
      closed,
      note: exception.find((w) => w.note)?.note ?? null,
      windows: closed ? [] : mergeIntervals(exception),
    };
  }
  return weeklyDay(all, parseDateKey(dateStr)?.getDay() ?? -1);
}

/** חלונות היום שמתאימים למסלול (ללא מסלול — כולם), עם איחוד חלונות רצופים: ההזמנה יכולה להימשך על פניהם */
function matchingWindows(day: ResolvedDay, track?: BookingTrack): DayInterval[] {
  return mergeIntervals(day.windows.filter((w) => activityMatches(w.activity, track)), false);
}

export function fitsOpening(day: ResolvedDay, startMinutes: number, endMinutes: number, track?: BookingTrack): boolean {
  return matchingWindows(day, track).some((w) => startMinutes >= w.startMinutes && endMinutes <= w.endMinutes);
}

export function formatWindow(w: DayInterval): string {
  return `${formatMinutes(w.startMinutes)}–${formatMinutes(w.endMinutes)}`;
}

function formatWindows(windows: DayInterval[]): string {
  return windows.map(formatWindow).join(" · ");
}

/** הסבר בעברית מדוע טווח אינו זמין (למסלול הנבחר), או null אם הוא זמין */
export function explainUnavailable(
  day: ResolvedDay,
  startMinutes: number,
  endMinutes: number,
  track?: BookingTrack
): string | null {
  if (fitsOpening(day, startMinutes, endMinutes, track)) return null;
  if (day.closed) return `סגור בתאריך זה${day.note ? ` (${day.note})` : ""}`;
  if (day.windows.length === 0) return "אין פעילות ביום זה";
  const trackLabel = track ? ACTIVITY_LABELS[track] : "";
  const mismatch = day.windows.find(
    (w) => !activityMatches(w.activity, track) && w.startMinutes < endMinutes && w.endMinutes > startMinutes
  );
  if (mismatch) {
    return `בשעות אלה מתקיימת פעילות ${ACTIVITY_LABELS[mismatch.activity]}, שאינה מתאימה למסלול ${trackLabel}`;
  }
  const own = matchingWindows(day, track);
  if (own.length === 0) return `אין חלונות המתאימים למסלול ${trackLabel} ביום זה`;
  return `מחוץ לשעות הפעילות${track ? ` של מסלול ${trackLabel}` : ""} (${formatWindows(own)})`;
}

/** האם הזמנה (תאריך+שעות מקומיים) במסלול נתון מותרת לפי ההגדרות? מחזיר הסבר לדחייה או null. זו נקודת האימות היחידה לשרת */
export function bookingViolation(all: HoursWindow[], start: Date, end: Date, track?: BookingTrack): string | null {
  const from = jerusalemParts(start);
  const to = jerusalemParts(end);
  if (from.date !== to.date) return "ההזמנה חייבת להיות בתוך יום אחד";
  return explainUnavailable(resolveDay(all, from.date), from.minutes, to.minutes, track);
}

/**
 * יום סגור קבוע (שבת, 00:00–24:00 בשעון ירושלים): נחסם לכל התפקידים, כולל מנהל.
 * בודק את תחילת ההזמנה ואת הרגע האחרון שלה (הסיום עצמו אינו נכלל).
 */
export function closedDayViolation(start: Date, end: Date): string | null {
  const last = new Date(Math.max(start.getTime(), end.getTime() - 1));
  if (isClosedWeekday(jerusalemParts(start).weekday) || isClosedWeekday(jerusalemParts(last).weekday)) {
    return "המכון סגור בשבת — לא ניתן לקבוע תור ביום שבת";
  }
  return null;
}

/** יום שהוגדר כסגור (קבוע בשבוע או חריג לתאריך) חוסם הזמנה לכולם, כולל מנהל */
function closedDayRejection(all: HoursWindow[], start: Date, end: Date): string | null {
  for (const date of new Set([jerusalemParts(start).date, jerusalemParts(end).date])) {
    const day = resolveDay(all, date);
    if (day.closed) return `סגור בתאריך זה${day.note ? ` (${day.note})` : ""}`;
  }
  return null;
}

/**
 * יום סגור חוסם את כולם (גם מנהל); שעות הפעילות והמסלול נאכפים על כולם מלבד מנהל (source ADMIN),
 * שרשאי לחרוג מהן בימי פעילות. שבת נבדקת בנפרד ותמיד קודם (closedDayViolation).
 */
export function hoursRejection(
  all: HoursWindow[],
  start: Date,
  end: Date,
  source: string,
  track?: BookingTrack
): string | null {
  return closedDayRejection(all, start, end) ?? (source === "ADMIN" ? null : bookingViolation(all, start, end, track));
}

/** טווח ברירת המחדל של יומן ביום ללא חלונות פתוחים ובלי תורים (8:00–20:00). אינו שעות פעילות — רק תצוגה */
const EMPTY_DAY_VIEW = { startMinutes: 8 * 60, endMinutes: 20 * 60 };

/**
 * טווח השעות (מיושר לשעות שלמות) שיוצג ביומן המנהל: חלונות הפעילות ושעה נוספת משני צדיהם,
 * מורחב כך שיכלול גם תורים שנמצאים מחוץ לפעילות. showAll = כל היממה.
 */
export function calendarRange(
  day: ResolvedDay,
  busy: { startMinutes: number; endMinutes: number }[],
  showAll = false
): { startMinutes: number; endMinutes: number } {
  if (showAll) return { startMinutes: 0, endMinutes: 24 * 60 };
  const spans = [
    ...day.windows.map((w) => ({ startMinutes: w.startMinutes - 60, endMinutes: w.endMinutes + 60 })),
    ...busy,
  ];
  if (spans.length === 0) return EMPTY_DAY_VIEW;
  const start = Math.min(...spans.map((s) => s.startMinutes));
  const end = Math.max(...spans.map((s) => s.endMinutes));
  return {
    startMinutes: Math.max(0, Math.floor(start / 60) * 60),
    endMinutes: Math.min(24 * 60, Math.ceil(end / 60) * 60),
  };
}

/** ולידציה לרשימת חלונות של יום אחד: תקינות, גבולות, סוג פעילות וחפיפה (גם בין סוגים שונים — לוח אחד ליום). מחזיר הודעת שגיאה או null */
export function validateWindows(list: DayInterval[]): string | null {
  if (list.length > MAX_WINDOWS_PER_SCOPE) return "יותר מדי חלונות ליום אחד";
  for (const w of list) {
    if (!Number.isInteger(w.startMinutes) || !Number.isInteger(w.endMinutes)) return "שעות לא תקינות";
    if (w.startMinutes < 0 || w.endMinutes > 24 * 60) return "השעות חייבות להיות בתוך היממה";
    if (w.startMinutes % STEP_MINUTES !== 0 || w.endMinutes % STEP_MINUTES !== 0) {
      return `השעות חייבות להיות בקפיצות של ${STEP_MINUTES} דקות`;
    }
    if (w.endMinutes <= w.startMinutes) return "שעת הסיום חייבת להיות אחרי שעת ההתחלה";
    if (!isActivityType(w.activity)) return "מסלול פעילות לא תקין";
  }
  const sorted = [...list].sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinutes < sorted[i - 1].endMinutes) {
      return `חפיפת שעות: ${formatMinutes(sorted[i].startMinutes)} מתחיל לפני ${formatMinutes(sorted[i - 1].endMinutes)}`;
    }
  }
  return null;
}
