import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppointment } from "@/lib/booking";
import {
  parseTimeOption,
  formatMinutes,
  calendarRange,
  trackForGender,
  DEFAULT_WEEKDAY_ACTIVITY,
  isActivityType,
  isClosedDate,
  hoursRejection,
  bookingViolation,
  closedDayViolation,
  jerusalemParts,
  explainUnavailable,
  fitsOpening,
  resolveDay,
  OPEN_WEEKDAYS,
  validateWindows,
  weeklyDayClosed,
  weeklyDefaultActivity,
  weeklyWindows,
  type ActivityType,
  type HoursWindow,
} from "@/lib/opening-hours";

const weekly = (weekday: number, s: number, e: number, activity: ActivityType = "BOYS"): HoursWindow => ({
  weekday, date: null, startMinutes: s * 60, endMinutes: e * 60, closed: false, activity,
});
const onDate = (date: string, s: number, e: number, activity: ActivityType = "BOYS"): HoursWindow => ({
  weekday: null, date, startMinutes: s * 60, endMinutes: e * 60, closed: false, activity,
});
const closedOn = (date: string, note: string | null = null): HoursWindow => ({
  weekday: null, date, startMinutes: 0, endMinutes: 1440, closed: true, activity: "BOYS", note,
});

// 2030-01-06 = יום ראשון (weekday 0), 2030-01-07 = שני
const SUN = "2030-01-06";
const MON = "2030-01-07";
const at = (date: string, h: number, m = 0) => new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`); // חורף: ירושלים = UTC+2

// ראשון: שני חלונות נפרדים; שני: חלון אחד
const base = [weekly(0, 8, 12), weekly(0, 16, 20), weekly(1, 9, 17)];

test("חלונות שונים באותו יום, ושעות שונות בימים שונים", () => {
  const sun = resolveDay(base, SUN);
  assert.equal(sun.source, "weekly");
  assert.deepEqual(sun.windows, [
    { startMinutes: 480, endMinutes: 720, activity: "BOYS" },
    { startMinutes: 960, endMinutes: 1200, activity: "BOYS" },
  ]);
  assert.equal(fitsOpening(sun, 16 * 60, 17 * 60), true);
  assert.equal(fitsOpening(sun, 13 * 60, 14 * 60), false); // הפער בין החלונות
  assert.equal(fitsOpening(resolveDay(base, MON), 9 * 60, 10 * 60), true);
  assert.equal(fitsOpening(resolveDay(base, MON), 8 * 60, 9 * 60), false);
});

test("חריג לתאריך דורס רק את אותו תאריך, לא את שאר השבוע", () => {
  const all = [...base, onDate(SUN, 10, 12)];
  const day = resolveDay(all, SUN);
  assert.equal(day.source, "exception");
  assert.equal(fitsOpening(day, 8 * 60, 9 * 60), false);
  assert.equal(fitsOpening(day, 16 * 60, 17 * 60), false); // החריג מחליף את כל היום
  assert.equal(fitsOpening(resolveDay(all, "2030-01-13"), 8 * 60, 9 * 60), true); // ראשון הבא כרגיל
  assert.equal(fitsOpening(resolveDay(all, MON), 9 * 60, 10 * 60), true);
  assert.equal(weeklyWindows(all, 0).length, 2); // ברירת המחדל עצמה לא השתנתה
});

test("יום סגור כחריג", () => {
  const day = resolveDay([...base, closedOn(SUN, "חג")], SUN);
  assert.equal(day.closed, true);
  assert.match(explainUnavailable(day, 600, 660, "BOYS")!, /סגור.*חג/);
});

test("הזמנה חייבת להיכנס כולה בחלון; חלונות צמודים מתחברים", () => {
  const day = resolveDay([weekly(0, 8, 12), weekly(0, 12, 16)], SUN);
  assert.equal(fitsOpening(day, 11 * 60 + 30, 12 * 60 + 30), true);
  assert.equal(fitsOpening(day, 15 * 60 + 30, 16 * 60 + 30), false);
  assert.equal(fitsOpening(day, 7 * 60 + 30, 8 * 60 + 30), false);
});

test("הסבר מופיע עם שעות היום או חוסר פעילות", () => {
  const day = resolveDay(base, SUN);
  assert.equal(explainUnavailable(day, 8 * 60, 9 * 60, "BOYS"), null);
  assert.match(explainUnavailable(day, 13 * 60, 14 * 60, "BOYS")!, /08:00–12:00 · 16:00–20:00/);
  // יום בלי חלונות מפורשים (שלישי) פתוח 08:00–21:00 במסלול ברירת המחדל שלו (בנות)
  assert.match(explainUnavailable(resolveDay(base, "2030-01-08"), 600, 660, "BOYS")!, /בנות.*אינה מתאימה למסלול בנים/);
});

test("אימות צד שרת: אותו לוח לכל החדרים", () => {
  assert.equal(bookingViolation(base, at(SUN, 8), at(SUN, 9), "BOYS"), null);
  assert.equal(bookingViolation(base, at(SUN, 16), at(SUN, 17), "BOYS"), null);
  assert.ok(bookingViolation(base, at(SUN, 11, 30), at(SUN, 12, 30), "BOYS"));
  assert.ok(bookingViolation(base, at(SUN, 13), at(SUN, 14), "BOYS"));
  assert.ok(bookingViolation(base, at(SUN, 19), at(MON, 1), "BOYS")); // חוצה חצות
  assert.ok(bookingViolation([...base, closedOn(SUN)], at(SUN, 8), at(SUN, 9), "BOYS"));
});

test("ולידציית חלונות: חפיפה נדחית, חלונות צמודים ותקינות שעות", () => {
  const w = (s: number, e: number, activity: ActivityType = "BOYS") => ({ startMinutes: s * 60, endMinutes: e * 60, activity });
  assert.match(validateWindows([w(8, 12), w(11, 14)])!, /חפיפת/);
  assert.equal(validateWindows([w(8, 12), w(12, 14)]), null);
  assert.equal(validateWindows([w(16, 20), w(8, 12)]), null);
  assert.ok(validateWindows([w(12, 8)]));
  assert.ok(validateWindows([w(8, 25)]));
  assert.ok(validateWindows([{ startMinutes: 483, endMinutes: 600, activity: "BOYS" as const }]));
});

// 2030-01-12 = שבת
const SAT = "2030-01-12";

test("שבת סגורה תמיד: ברירת מחדל, חריג וחלונות שמורים לא פותחים אותה", () => {
  assert.deepEqual(OPEN_WEEKDAYS, [0, 1, 2, 3, 4, 5]);
  const all = [...base, weekly(6, 8, 20), onDate(SAT, 10, 12)];
  const day = resolveDay(all, SAT);
  assert.equal(day.closed, true);
  assert.deepEqual(day.windows, []);
  assert.match(explainUnavailable(day, 600, 660, "BOYS")!, /סגור/);
  assert.ok(bookingViolation(all, at(SAT, 10), at(SAT, 11), "BOYS"));
  assert.equal(bookingViolation(all, at("2030-01-11", 10), at("2030-01-11", 11), "BOYS"), null); // שישי ללא חלונות מפורשים: ברירת מחדל (בנים) פתוחה
});

// ---- שבת סגורה לכולם, כולל מנהל ----
// ‏2030-01-12 שבת; רגעי UTC נבחרו כך שיעמדו בבדיקה לפי שעון ירושלים (חורף UTC+2)
const iso = (s: string) => new Date(s);

test("closedDayViolation: שבת 00:00–24:00 לפי ירושלים, ללא תלות באזור הזמן של השרת", () => {
  assert.ok(closedDayViolation(iso("2030-01-12T08:00:00+02:00"), iso("2030-01-12T09:00:00+02:00")));
  assert.ok(closedDayViolation(iso("2030-01-12T00:00:00+02:00"), iso("2030-01-12T01:00:00+02:00"))); // תחילת שבת
  assert.ok(closedDayViolation(iso("2030-01-12T23:00:00+02:00"), iso("2030-01-13T00:00:00+02:00"))); // סוף שבת
  assert.ok(closedDayViolation(iso("2030-01-11T23:30:00+02:00"), iso("2030-01-12T00:30:00+02:00"))); // שישי שחוצה לשבת
  assert.equal(closedDayViolation(iso("2030-01-11T22:00:00+02:00"), iso("2030-01-12T00:00:00+02:00")), null); // מסתיים בדיוק בחצות
  assert.equal(closedDayViolation(iso("2030-01-13T00:00:00+02:00"), iso("2030-01-13T01:00:00+02:00")), null); // ראשון
  assert.equal(closedDayViolation(iso("2030-01-10T10:00:00+02:00"), iso("2030-01-10T11:00:00+02:00")), null); // חמישי
  // 22:30 UTC בליל שישי = 00:30 שבת בירושלים
  assert.ok(closedDayViolation(iso("2030-01-11T22:30:00Z"), iso("2030-01-11T23:30:00Z")));
});

test("שבת חסומה ללא תלות בתפקיד, בחלון שבת שמור או בחריג", () => {
  const sat = (h: number) => iso(`2030-01-12T${String(h).padStart(2, "0")}:00:00+02:00`);
  const opened = [...base, weekly(6, 8, 20), onDate(SAT, 8, 20)];
  // הסגירה אינה תלויה בחלונות בכלל (closedDayViolation לא מקבלת אותם) וגוברת על פטור המנהל
  assert.ok(closedDayViolation(sat(10), sat(11)));
  // יום סגור חוסם גם מנהל, גם דרך לוח השעות (resolveDay) וגם דרך הבדיקה הטהורה שלפני הגישה למסד
  assert.ok(hoursRejection(opened, sat(10), sat(11), "ADMIN", "BOYS"));
  for (const source of ["WEB", "IVR"]) assert.ok(hoursRejection(opened, sat(10), sat(11), source, "BOYS"), source);
});

test("hoursRejection: הרשאת המנהל לחרוג משעות הפעילות בימי חול נשמרת", () => {
  const sun = (h: number) => iso(`2030-01-06T${String(h).padStart(2, "0")}:00:00+02:00`);
  // ראשון 13:00 נמצא בפער בין החלונות
  assert.equal(hoursRejection(base, sun(13), sun(14), "ADMIN", "BOYS"), null);
  assert.ok(hoursRejection(base, sun(13), sun(14), "WEB", "BOYS"));
  assert.ok(hoursRejection(base, sun(13), sun(14), "IVR", "BOYS"));
  assert.equal(hoursRejection(base, sun(9), sun(10), "WEB", "BOYS"), null);
});

test("createAppointment: מנהל (ADMIN) נדחה בשבת עוד לפני גישה למסד הנתונים", async () => {
  const start = new Date(); // השבת הקרובה בעוד 400 ימים, 10:00 לפי ירושלים
  start.setDate(start.getDate() + 400);
  while (jerusalemParts(start).weekday !== 6) start.setDate(start.getDate() + 1);
  start.setUTCHours(8, 0, 0, 0);
  const end = new Date(start.getTime() + 3600_000);
  for (const source of ["ADMIN", "WEB", "IVR"] as const) {
    await assert.rejects(
      createAppointment({ userId: "x", roomKey: "ROOM1", startTime: start, endTime: end, source }),
      /המכון סגור בשבת/
    );
  }
});

// ---- מסלולי פעילות: בנים / בנות ----
// ראשון: 08–12 בנים, 12–16 בנות, 16–20 בנים
const mixed = [weekly(0, 8, 12, "BOYS"), weekly(0, 12, 16, "GIRLS"), weekly(0, 16, 20, "BOYS")];

test("ברירות מחדל שבועיות: ראשון/שלישי/חמישי בנות; שני/רביעי/שישי בנים", () => {
  assert.deepEqual(
    OPEN_WEEKDAYS.map((d) => DEFAULT_WEEKDAY_ACTIVITY[d]),
    ["GIRLS", "BOYS", "GIRLS", "BOYS", "GIRLS", "BOYS"]
  );
});

test("חלון מתאים למסלול רק אם הוא באותו מסלול; בלי מסלול כל חלון מתאים", () => {
  const day = resolveDay(mixed, SUN);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "BOYS"), true);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "GIRLS"), false);
  assert.equal(fitsOpening(day, 13 * 60, 14 * 60, "GIRLS"), true);
  assert.equal(fitsOpening(day, 13 * 60, 14 * 60, "BOYS"), false);
  assert.equal(fitsOpening(day, 13 * 60, 14 * 60), true); // ללא מסלול (IVR)
  assert.equal(fitsOpening(day, 17 * 60, 18 * 60, "BOYS"), true);
});

test("הזמנה לא נמשכת על פני חלונות של מסלולים שונים, אבל כן על פני חלונות רצופים באותו מסלול", () => {
  const day = resolveDay(mixed, SUN);
  assert.equal(fitsOpening(day, 11 * 60 + 30, 12 * 60 + 30, "BOYS"), false);
  assert.equal(fitsOpening(day, 11 * 60 + 30, 12 * 60 + 30, "GIRLS"), false);
  assert.equal(fitsOpening(day, 11 * 60 + 30, 12 * 60 + 30), true); // ללא מסלול: הלוח רציף
  const sameTrack = resolveDay([weekly(0, 8, 12, "GIRLS"), weekly(0, 12, 16, "GIRLS")], SUN);
  assert.equal(fitsOpening(sameTrack, 11 * 60 + 30, 12 * 60 + 30, "GIRLS"), true);
});

test("הסבר לחלון לא מתאים כולל את שם המסלול", () => {
  const day = resolveDay(mixed, SUN);
  assert.match(explainUnavailable(day, 9 * 60, 10 * 60, "GIRLS")!, /בנים.*אינה מתאימה למסלול בנות/);
  assert.match(explainUnavailable(resolveDay([weekly(0, 8, 12, "BOYS")], SUN), 13 * 60, 14 * 60, "GIRLS")!, /אין חלונות המתאימים למסלול בנות/);
  assert.match(explainUnavailable(day, 21 * 60, 22 * 60, "BOYS")!, /מחוץ לשעות הפעילות של מסלול בנים \(08:00–12:00 · 16:00–20:00\)/);
  assert.match(explainUnavailable(day, 21 * 60, 22 * 60)!, /^מחוץ לשעות הפעילות \(/);
});

test("אימות צד שרת לפי מסלול; IVR ללא מסלול; מנהל פטור בימי חול", () => {
  const t = (h: number) => at(SUN, h);
  assert.equal(hoursRejection(mixed, t(13), t(14), "WEB", "GIRLS"), null);
  assert.ok(hoursRejection(mixed, t(13), t(14), "WEB", "BOYS"));
  assert.equal(hoursRejection(mixed, t(13), t(14), "IVR"), null); // IVR אינו בוחר מסלול — כל חלון פתוח
  assert.ok(hoursRejection(mixed, t(21), t(22), "IVR")); // אבל שעות הפעילות נאכפות
  assert.equal(hoursRejection(mixed, t(21), t(22), "ADMIN", "BOYS"), null);
  assert.ok(isActivityType("BOYS") && isActivityType("GIRLS") && !isActivityType("GENERAL") && !isActivityType(undefined));
});

test("חריג לתאריך עם מסלול דורס את מסלולי ברירת המחדל", () => {
  const all = [...mixed, onDate(SUN, 9, 12, "GIRLS")];
  const day = resolveDay(all, SUN);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "GIRLS"), true);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "BOYS"), false);
  assert.equal(fitsOpening(resolveDay(all, "2030-01-13"), 9 * 60, 10 * 60, "BOYS"), true); // שבוע הבא כרגיל
});

test("שבת סגורה גם כשיש חלון מסלול שמור", () => {
  const all = [...mixed, weekly(6, 8, 20, "GIRLS"), onDate(SAT, 8, 20, "BOYS")];
  assert.equal(resolveDay(all, SAT).closed, true);
  assert.equal(fitsOpening(resolveDay(all, SAT), 9 * 60, 10 * 60, "GIRLS"), false);
});

test("ולידציה: חפיפה נדחית גם בין מסלולים שונים, ומסלול לא תקין נדחה", () => {
  const w = (s: number, e: number, activity: ActivityType) => ({ startMinutes: s * 60, endMinutes: e * 60, activity });
  assert.match(validateWindows([w(8, 12, "BOYS"), w(11, 14, "GIRLS")])!, /חפיפת/);
  assert.equal(validateWindows([w(8, 12, "BOYS"), w(12, 14, "GIRLS")]), null);
  assert.ok(validateWindows([{ startMinutes: 480, endMinutes: 600, activity: "GENERAL" as ActivityType }]));
});

test("מסלול המשתמש נקבע לפי מגדר: גבר — בנים, אישה — בנות; ללא מגדר — אין מסלול", () => {
  assert.equal(trackForGender("MALE"), "BOYS");
  assert.equal(trackForGender("FEMALE"), "GIRLS");
  assert.equal(trackForGender(null), undefined);
  assert.equal(trackForGender(undefined), undefined);
  // בשילוב עם הלוח: גבר אינו יכול להזמין בחלון של בנות
  const day = [weekly(0, 8, 12, "GIRLS"), weekly(0, 16, 20, "BOYS")];
  assert.ok(hoursRejection(day, at(SUN, 9), at(SUN, 10), "WEB", trackForGender("MALE")));
  assert.equal(hoursRejection(day, at(SUN, 9), at(SUN, 10), "WEB", trackForGender("FEMALE")), null);
  assert.ok(hoursRejection(day, at(SUN, 17), at(SUN, 18), "IVR", trackForGender("FEMALE")));
  assert.equal(hoursRejection(day, at(SUN, 17), at(SUN, 18), "IVR", trackForGender("MALE")), null);
});

test("jerusalemParts: תאריך, דקות ויום בשבוע לפי ירושלים, בלי תלות באזור הזמן של המכונה", () => {
  assert.deepEqual(jerusalemParts(new Date("2030-01-11T22:30:00Z")), { date: "2030-01-12", minutes: 30, weekday: 6 }); // 00:30 שבת
  assert.deepEqual(jerusalemParts(new Date("2030-01-06T07:00:00Z")), { date: "2030-01-06", minutes: 540, weekday: 0 }); // 09:00 ראשון
  assert.deepEqual(jerusalemParts(new Date("2030-07-01T21:30:00Z")), { date: "2030-07-02", minutes: 30, weekday: 2 }); // קיץ UTC+3
  assert.deepEqual(jerusalemParts(new Date("2030-01-06T22:00:00Z")), { date: "2030-01-07", minutes: 0, weekday: 1 }); // חצות: h23, לא 24:00
});

test("isClosedDate: שבת וקלט לא תקין סגורים; ימי חול פתוחים", () => {
  assert.equal(isClosedDate("2030-01-12"), true);
  assert.equal(isClosedDate("2030-01-11"), false);
  assert.equal(isClosedDate("2030-13-40"), true);
});

test("calendarRange: חלונות + שעה נוספת, מורחב לתורים מחוץ לפעילות, או כל היממה", () => {
  const day = resolveDay([weekly(0, 9, 17, "GIRLS")], SUN);
  assert.deepEqual(calendarRange(day, []), { startMinutes: 8 * 60, endMinutes: 18 * 60 });
  // תור ב-20:00–21:00 מחוץ לפעילות מרחיב את התצוגה; תור בתוך הפעילות לא משנה
  assert.deepEqual(calendarRange(day, [{ startMinutes: 20 * 60, endMinutes: 21 * 60 }]), { startMinutes: 8 * 60, endMinutes: 21 * 60 });
  assert.deepEqual(calendarRange(day, [{ startMinutes: 10 * 60, endMinutes: 11 * 60 }]), { startMinutes: 8 * 60, endMinutes: 18 * 60 });
  assert.deepEqual(calendarRange(day, [], true), { startMinutes: 0, endMinutes: 24 * 60 });
  // יום סגור: רק תורים קיימים, ללא תורים — טווח ברירת מחדל לתצוגה
  const closed = resolveDay([], SAT);
  assert.deepEqual(calendarRange(closed, [{ startMinutes: 10 * 60 + 30, endMinutes: 11 * 60 + 30 }]), { startMinutes: 10 * 60, endMinutes: 12 * 60 });
  assert.deepEqual(calendarRange(closed, []), { startMinutes: 8 * 60, endMinutes: 20 * 60 });
  // לא חורג מהיממה
  const late = resolveDay([weekly(0, 0, 24, "GIRLS")], SUN);
  assert.deepEqual(calendarRange(late, []), { startMinutes: 0, endMinutes: 24 * 60 });
});

test("parseTimeOption / buildTimeOptions: כל היממה בקפיצות, ללא תלות ב-BUSINESS_HOURS", async () => {
  const { buildTimeOptions } = await import("@/lib/slots");
  const options = buildTimeOptions();
  assert.equal(options[0], "00:00");
  assert.equal(options.at(-1), "23:45");
  assert.equal(options.length, 96);
  assert.equal(parseTimeOption("13:45"), 13 * 60 + 45);
  assert.equal(formatMinutes(parseTimeOption("07:05")), "07:05");
});

// ---- יום בלי חלונות מפורשים: 08:00–21:00 במסלול היום ----
const dayDefault = (weekday: number, activity: ActivityType): HoursWindow => ({
  weekday, date: null, startMinutes: 8 * 60, endMinutes: 21 * 60, closed: false, activity, dayDefault: true,
});

test("בלי שום הגדרה: כל יום חול פתוח 08:00–21:00 במסלול ברירת המחדל של היום", () => {
  for (const [date, track] of [[SUN, "GIRLS"], [MON, "BOYS"], ["2030-01-08", "GIRLS"]] as const) {
    const day = resolveDay([], date);
    assert.deepEqual(day.windows, [{ startMinutes: 480, endMinutes: 1260, activity: track }]);
    assert.equal(day.source, "weekly");
    assert.equal(fitsOpening(day, 8 * 60, 9 * 60, track), true);
    assert.equal(fitsOpening(day, 20 * 60, 21 * 60, track), true);
    assert.equal(fitsOpening(day, 20 * 60 + 30, 21 * 60 + 30, track), false);
    assert.equal(fitsOpening(day, 9 * 60, 10 * 60, track === "BOYS" ? "GIRLS" : "BOYS"), false);
  }
  assert.equal(resolveDay([], SAT).closed, true); // שבת נשארת סגורה
});

test("מסלול היום שנשמר (שורת dayDefault) קובע את המסלול גם בלי חלונות מפורשים", () => {
  const saved = [dayDefault(0, "BOYS")]; // ראשון: ברירת מחדל מובנית בנות, אך נשמר בנים
  assert.equal(weeklyDefaultActivity(saved, 0), "BOYS");
  assert.equal(weeklyDefaultActivity(saved, 2), "GIRLS"); // יום אחר — ברירת המחדל המובנית
  const day = resolveDay(saved, SUN);
  assert.deepEqual(day.windows, [{ startMinutes: 480, endMinutes: 1260, activity: "BOYS" }]);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "BOYS"), true);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "GIRLS"), false);
  assert.deepEqual(weeklyWindows(saved, 0), []); // שורת היום אינה חלון מפורש בממשק
});

test("חלונות מפורשים גוברים על ברירת המחדל — ללא פעילות כפולה", () => {
  const all = [dayDefault(0, "BOYS"), weekly(0, 10, 12, "GIRLS")];
  const day = resolveDay(all, SUN);
  assert.deepEqual(day.windows, [{ startMinutes: 600, endMinutes: 720, activity: "GIRLS" }]);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "BOYS"), false); // 08–21 בנים לא נשאר פתוח
  assert.equal(fitsOpening(day, 16 * 60, 17 * 60, "BOYS"), false);
  assert.equal(fitsOpening(day, 10 * 60, 11 * 60, "GIRLS"), true);
  // יום אחר ללא חלונות מפורשים אינו מושפע
  assert.equal(resolveDay(all, MON).windows.length, 1);
});

test("חריג לתאריך גובר על מסלול היום ועל חלונות היום", () => {
  const all = [dayDefault(0, "BOYS"), onDate(SUN, 9, 10, "GIRLS")];
  assert.deepEqual(resolveDay(all, SUN).windows, [{ startMinutes: 540, endMinutes: 600, activity: "GIRLS" }]);
  assert.equal(resolveDay(all, "2030-01-13").windows[0].activity, "BOYS"); // ראשון הבא: מסלול היום
});

test("אימות הזמנה בימים ללא חלונות מפורשים: לפי ברירת המחדל והמסלול", () => {
  assert.equal(hoursRejection([], at(SUN, 8), at(SUN, 9), "WEB", "GIRLS"), null);
  assert.ok(hoursRejection([], at(SUN, 8), at(SUN, 9), "WEB", "BOYS"));
  assert.ok(hoursRejection([], at(SUN, 7), at(SUN, 8), "IVR", "GIRLS")); // לפני 08:00
  assert.equal(hoursRejection([], at(SUN, 7), at(SUN, 8), "ADMIN", "BOYS"), null); // מנהל פטור בימי חול
});

// ---- יום קבוע סגור (שורת "מסלול היום" עם closed) ----
const closedDay = (weekday: number, activity: ActivityType = "BOYS"): HoursWindow => ({
  weekday, date: null, startMinutes: 8 * 60, endMinutes: 21 * 60, closed: true, activity, dayDefault: true,
});

test("יום שהוגדר סגור: אין פעילות, גם כשיש חלונות מפורשים שמורים", () => {
  const all = [closedDay(0), weekly(0, 9, 12, "GIRLS"), weekly(0, 14, 18, "BOYS")];
  assert.equal(weeklyDayClosed(all, 0), true);
  assert.equal(weeklyDayClosed(all, 1), false);
  const day = resolveDay(all, SUN);
  assert.equal(day.closed, true);
  assert.deepEqual(day.windows, []);
  assert.equal(fitsOpening(day, 9 * 60, 10 * 60, "GIRLS"), false);
  assert.equal(fitsOpening(day, 15 * 60, 16 * 60, "BOYS"), false);
  assert.match(explainUnavailable(day, 9 * 60, 10 * 60, "GIRLS")!, /סגור/);
  assert.equal(resolveDay(all, MON).closed, false); // יום אחר לא מושפע
  assert.equal(weeklyWindows(all, 0).length, 2); // החלונות נשמרו (לא נמחקו) אך אינם פעילים
});

test("יום סגור חוסם את כולם, כולל מנהל; מנהל נשאר פטור משעות בימי פעילות", () => {
  const all = [closedDay(0)];
  for (const source of ["WEB", "IVR", "ADMIN"]) assert.ok(hoursRejection(all, at(SUN, 10), at(SUN, 11), source, "BOYS"), source);
  assert.equal(hoursRejection(all, at(MON, 22), at(MON, 23), "ADMIN"), null); // שני פתוח: מנהל רשאי מחוץ לשעות
  assert.ok(hoursRejection(all, at(MON, 22), at(MON, 23), "WEB", "BOYS"));
});

test("מעבר מסגור חזרה לפעילות מחזיר את השעות הרגילות (במסלול השמור)", () => {
  const reopened = [{ ...closedDay(0, "GIRLS"), closed: false }];
  const day = resolveDay(reopened, SUN);
  assert.equal(day.closed, false);
  assert.deepEqual(day.windows, [{ startMinutes: 480, endMinutes: 1260, activity: "GIRLS" }]);
  // חלונות מפורשים פעילים שוב אחרי פתיחה
  const withExplicit = [...reopened, weekly(0, 10, 12, "GIRLS")];
  assert.deepEqual(resolveDay(withExplicit, SUN).windows, [{ startMinutes: 600, endMinutes: 720, activity: "GIRLS" }]);
});

test("חריג לתאריך פותח יום שהוגדר סגור רק באותו תאריך; חריג סגור חוסם גם מנהל", () => {
  const all = [closedDay(0), onDate(SUN, 9, 12, "GIRLS")];
  assert.equal(resolveDay(all, SUN).closed, false);
  assert.equal(hoursRejection(all, at(SUN, 10), at(SUN, 11), "WEB", "GIRLS"), null);
  assert.equal(resolveDay(all, "2030-01-13").closed, true); // ראשון הבא נשאר סגור
  const closedException = [closedOn(MON, "חג")];
  assert.ok(hoursRejection(closedException, at(MON, 10), at(MON, 11), "ADMIN"));
});
