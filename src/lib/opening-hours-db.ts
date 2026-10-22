import { prisma } from "@/lib/prisma";
import { BookingError } from "@/lib/booking-error";
import {
  closedDayViolation,
  DEFAULT_DAY_WINDOW,
  hoursRejection,
  trackForGender,
  fitsOpening,
  isActivityType,
  isClosedDate,
  isClosedWeekday,
  jerusalemParts,
  resolveDay,
  validateWindows,
  type ActivityType,
  type BookingTrack,
  type DayInterval,
  type HoursWindow,
  type ResolvedDay,
} from "@/lib/opening-hours";

/** מקור הנתונים היחיד לשעות הפעילות (לוח אחד לכל החדרים): הדף הציבורי, הניהול וההזמנות (אתר, IVR, API) קוראים מכאן */

/** סימון בעמודת note של שורה שבועית שהיא "מסלול היום" (08:00–21:00) ולא חלון מפורש — כך אין צורך בשינוי סכמה */
const DAY_DEFAULT_NOTE = "__DAY_DEFAULT__";

/** כל החלונות הפעילים. יום בלי חלונות מפורשים נפתר ל-DEFAULT_DAY_WINDOW במסלול היום (ראו weeklyDay) */
export async function loadWindows(): Promise<HoursWindow[]> {
  const rows = await prisma.openingWindow.findMany({
    where: { active: true },
    orderBy: [{ startMinutes: "asc" }],
  });
  return rows.map((r) => ({
    dayDefault: r.note === DAY_DEFAULT_NOTE,
    id: r.id,
    weekday: r.weekday,
    date: r.date,
    startMinutes: r.startMinutes,
    endMinutes: r.endMinutes,
    closed: r.closed,
    activity: r.activity,
    note: r.note === DAY_DEFAULT_NOTE ? null : r.note,
  }));
}

export async function loadDay(dateStr: string): Promise<ResolvedDay> {
  return resolveDay(await loadWindows(), dateStr);
}

/** מסלול ההזמנה של משתמש לפי המגדר שבפרופיל שלו (מהמסד, לא מהבקשה); undefined אם המגדר לא הוגדר */
export async function trackForUser(userId: string): Promise<BookingTrack | undefined> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
  return trackForGender(user?.gender);
}

/**
 * אימות צד שרת לכל יצירת הזמנה (אתר, API, IVR, מנהל). קודם יום סגור (שבת) — לכולם, ללא גישה למסד;
 * אחר כך יום סגור (לכולם), ושעות הפעילות והמסלול של המשתמש (לפי המגדר שלו) שמנהל פטור מהם.
 */
export async function assertBookable(startTime: Date, endTime: Date, source: string, userId: string) {
  const closed = closedDayViolation(startTime, endTime);
  if (closed) throw new BookingError(`הזמן שנבחר אינו זמין: ${closed}`);
  // מנהל פטור מהמסלול ומשעות הפעילות, אך לא מיום סגור — לכן הלוח נטען גם עבורו
  const track = source === "ADMIN" ? undefined : await trackForUser(userId);
  if (source !== "ADMIN" && !track) throw new BookingError("יש להשלים מגדר בפרופיל כדי לקבוע תור");
  const reason = hoursRejection(await loadWindows(), startTime, endTime, source, track);
  if (reason) throw new BookingError(`הזמן שנבחר אינו זמין: ${reason}`);
}

/**
 * מחליף את הגדרת יום בשבוע: מסלול היום (נשמר גם בלי חלונות), האם היום סגור, והחלונות המפורשים. הישנים עוברים
 * לארכיון (active=false), לא נמחקים. חלונות מפורשים גוברים על מסלול היום בזמן הפתרון (weeklyDay), אך יום סגור
 * גובר עליהם. מסלול היום נשמר גם כשהיום סגור, כדי שמעבר חזרה לפעילות יחזיר את המסלול הקודם.
 */
export async function replaceWeekday(weekday: number, windows: DayInterval[], dayActivity: ActivityType, closed: boolean) {
  if (isClosedWeekday(weekday)) throw new BookingError("יום שבת סגור ולא ניתן להגדיר בו שעות פעילות");
  const err = validateWindows(windows);
  if (err) throw new BookingError(err);
  if (!isActivityType(dayActivity)) throw new BookingError("מסלול פעילות לא תקין");
  await prisma.$transaction([
    prisma.openingWindow.updateMany({ where: { active: true, date: null, weekday }, data: { active: false } }),
    prisma.openingWindow.createMany({
      data: [
        { weekday, ...DEFAULT_DAY_WINDOW, activity: dayActivity, closed, note: DAY_DEFAULT_NOTE },
        ...windows.map((w) => ({ weekday, startMinutes: w.startMinutes, endMinutes: w.endMinutes, activity: w.activity })),
      ],
    }),
  ]);
}

/** חריג לתאריך: יום סגור (closed) או חלונות מותאמים. דורס את כל ברירת המחדל באותו תאריך */
export async function replaceDate(
  date: string,
  input: { closed: true; note?: string | null } | { closed: false; windows: DayInterval[]; note?: string | null }
) {
  if (isClosedDate(date)) throw new BookingError("יום שבת סגור (או תאריך לא תקין) — לא ניתן להגדיר בו חריג");
  const note = input.note?.trim() || null;
  if (note && note.length > 100) throw new BookingError("ההערה ארוכה מדי");
  if (!input.closed) {
    const err = validateWindows(input.windows);
    if (err) throw new BookingError(err);
    if (input.windows.length === 0) throw new BookingError("יש להגדיר חלון אחד לפחות, או לסמן יום סגור");
  }
  const create = input.closed
    ? [{ date, closed: true, startMinutes: 0, endMinutes: 24 * 60, note }]
    : input.windows.map((w) => ({ date, startMinutes: w.startMinutes, endMinutes: w.endMinutes, activity: w.activity, note }));
  await prisma.$transaction([
    prisma.openingWindow.updateMany({ where: { active: true, date }, data: { active: false } }),
    prisma.openingWindow.createMany({ data: create }),
  ]);
}

/** ביטול חריג — חוזרים לברירת המחדל השבועית (החריג נשמר בארכיון) */
export async function clearDate(date: string) {
  await prisma.openingWindow.updateMany({ where: { active: true, date }, data: { active: false } });
}

/** הזמנות עתידיות שנופלות מחוץ להגדרות הנוכחיות (כולל מסלול המשתמש לפי מגדרו). הן לא מבוטלות ולא משתנות — רק מדווחות למנהל */
async function countAppointmentsOutsideHours(): Promise<number> {
  const [windows, appointments] = await Promise.all([
    loadWindows(),
    prisma.appointment.findMany({
      where: { status: "CONFIRMED", startTime: { gte: new Date() } },
      select: { startTime: true, endTime: true, user: { select: { gender: true } } },
    }),
  ]);
  const days = new Map<string, ResolvedDay>();
  let outside = 0;
  for (const a of appointments) {
    const from = jerusalemParts(a.startTime);
    const to = jerusalemParts(a.endTime);
    if (!days.has(from.date)) days.set(from.date, resolveDay(windows, from.date));
    const end = to.date === from.date ? to.minutes : 24 * 60;
    // משתמש ללא מגדר (תור שקבע מנהל) נבדק מול כל המסלולים
    if (!fitsOpening(days.get(from.date)!, from.minutes, end, trackForGender(a.user.gender))) outside++;
  }
  return outside;
}

/** תוצאת שמירה של ניהול השעות: הלוח המעודכן ומספר ההזמנות העתידיות שנשארו מחוץ אליו */
export async function loadSaveResult() {
  return { windows: await loadWindows(), outsideAppointments: await countAppointmentsOutsideHours() };
}
