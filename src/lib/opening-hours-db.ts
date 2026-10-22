import { prisma } from "@/lib/prisma";
import { BookingError } from "@/lib/booking-error";
import { BUSINESS_HOURS } from "@/lib/business-rules";
import {
  closedDayViolation,
  DEFAULT_WEEKDAY_ACTIVITY,
  hoursRejection,
  trackForGender,
  fitsOpening,
  isClosedDate,
  isClosedWeekday,
  jerusalemParts,
  OPEN_WEEKDAYS,
  resolveDay,
  validateWindows,
  type BookingTrack,
  type DayInterval,
  type HoursWindow,
  type ResolvedDay,
} from "@/lib/opening-hours";

/** מקור הנתונים היחיד לשעות הפעילות (לוח אחד לכל החדרים): הדף הציבורי, הניהול וההזמנות (אתר, IVR, API) קוראים מכאן */

let defaultsEnsured = false;

/**
 * בפעם הראשונה (טבלה ריקה לגמרי) נוצרת ברירת המחדל: ימי ראשון–שישי, BUSINESS_HOURS, ומסלול לפי DEFAULT_WEEKDAY_ACTIVITY.
 * נעילה ברמת המסד מונעת יצירה כפולה כששתי בקשות ראשונות רצות במקביל.
 */
async function ensureDefaults() {
  if (defaultsEnsured) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301)`;
    if ((await tx.openingWindow.count()) > 0) return;
    await tx.openingWindow.createMany({
      data: OPEN_WEEKDAYS.map((weekday) => ({
        weekday,
        activity: DEFAULT_WEEKDAY_ACTIVITY[weekday],
        startMinutes: BUSINESS_HOURS.startHour * 60,
        endMinutes: BUSINESS_HOURS.endHour * 60,
      })),
    });
  });
  defaultsEnsured = true;
}

export async function loadWindows(): Promise<HoursWindow[]> {
  await ensureDefaults();
  const rows = await prisma.openingWindow.findMany({
    where: { active: true },
    orderBy: [{ startMinutes: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    weekday: r.weekday,
    date: r.date,
    startMinutes: r.startMinutes,
    endMinutes: r.endMinutes,
    closed: r.closed,
    activity: r.activity,
    note: r.note,
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
 * אחר כך שעות הפעילות והמסלול של המשתמש (לפי המגדר שלו), שמנהל פטור מהם ולכן לא נטענים עבורו.
 */
export async function assertBookable(startTime: Date, endTime: Date, source: string, userId: string) {
  const closed = closedDayViolation(startTime, endTime);
  if (closed) throw new BookingError(`הזמן שנבחר אינו זמין: ${closed}`);
  if (source === "ADMIN") return;
  const track = await trackForUser(userId);
  if (!track) throw new BookingError("יש להשלים מגדר בפרופיל כדי לקבוע תור");
  const reason = hoursRejection(await loadWindows(), startTime, endTime, source, track);
  if (reason) throw new BookingError(`הזמן שנבחר אינו זמין: ${reason}`);
}

/** מחליף את חלונות יום בשבוע. הישנים עוברים לארכיון (active=false), לא נמחקים */
export async function replaceWeekday(weekday: number, windows: DayInterval[]) {
  if (isClosedWeekday(weekday)) throw new BookingError("יום שבת סגור ולא ניתן להגדיר בו שעות פעילות");
  const err = validateWindows(windows);
  if (err) throw new BookingError(err);
  await ensureDefaults();
  await prisma.$transaction([
    prisma.openingWindow.updateMany({ where: { active: true, date: null, weekday }, data: { active: false } }),
    prisma.openingWindow.createMany({
      data: windows.map((w) => ({ weekday, startMinutes: w.startMinutes, endMinutes: w.endMinutes, activity: w.activity })),
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
  await ensureDefaults();
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
