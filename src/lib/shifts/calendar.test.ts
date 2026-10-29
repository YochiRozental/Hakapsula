import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  billingMonths,
  groupByMonth,
  monthAmountAgorot,
  occurrenceDates,
  occurrencePriceAgorot,
  occurrenceTimes,
  shiftEndDate,
  validateStartDate,
  weekdayOf,
} from "@/lib/shifts/calendar";
import { SHIFT_WINDOWS } from "@/lib/payments/pricing";
import { jerusalemParts } from "@/lib/opening-hours";

// לוח שנה, תמחור ומעברי שעון של משמרות: פונקציות טהורות, ללא מסד נתונים.

test("מחיר מופע לכל אחת מארבע המשבצות (שעה = 41.60 ₪) בדיוק לפי הטבלה המאושרת", () => {
  assert.equal(occurrencePriceAgorot("MORNING"), 16640); // 4 שעות
  assert.equal(occurrencePriceAgorot("NOON"), 15600); // 3:45
  assert.equal(occurrencePriceAgorot("AFTERNOON"), 15600); // 3:45
  assert.equal(occurrencePriceAgorot("EVENING"), 11440); // 2:45
  for (const w of SHIFT_WINDOWS) assert.ok(Number.isInteger(occurrencePriceAgorot(w.id)));
});

test("חיוב חודשי: 4 מופעי בוקר = 665.60 ₪, 5 מופעים = 832 ₪, 0 = 0; אין שגיאות עיגול", () => {
  assert.equal(monthAmountAgorot("MORNING", 4), 66560);
  assert.equal(monthAmountAgorot("MORNING", 5), 83200);
  assert.equal(monthAmountAgorot("MORNING", 0), 0);
  assert.equal(monthAmountAgorot("EVENING", 13), 13 * 11440);
  assert.throws(() => monthAmountAgorot("MORNING", -1), RangeError);
  assert.throws(() => monthAmountAgorot("MORNING", 1.5), RangeError);
});

test("תקופה: שלושה חודשים קלנדריים, החודש הראשון נספר; סיום ביום האחרון של החודש השלישי", () => {
  assert.equal(shiftEndDate("2026-11-01"), "2027-01-31"); // מעבר שנה
  assert.equal(shiftEndDate("2026-11-18"), "2027-01-31"); // התחלה באמצע חודש
  assert.equal(shiftEndDate("2026-12-31"), "2027-02-28");
  assert.equal(shiftEndDate("2027-12-05"), "2028-02-29"); // שנה מעוברת
  assert.equal(shiftEndDate("2027-01-30"), "2027-03-31");
  assert.deepEqual(billingMonths("2026-11-18"), ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(billingMonths("2026-12-31"), ["2026-12", "2027-01", "2027-02"]);
});

test("מופעים: ביום השבוע הנבחר בלבד, בלי כפילויות ובלי אחרי הסיום; כולל התחלה באמצע חודש", () => {
  const dates = occurrenceDates("2026-11-18", 1); // יום שני
  assert.ok(dates.every((d) => weekdayOf(d) === 1));
  assert.equal(new Set(dates).size, dates.length);
  assert.equal(dates[0], "2026-11-23", "התחלה ביום רביעי: המופע הראשון ביום שני הבא");
  assert.ok(dates.at(-1)! <= "2027-01-31");
  assert.ok(addDays(dates.at(-1)!, 7) > "2027-01-31", "אין מופע שנשאר בתקופה");
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted);

  // התחלה בדיוק ביום המשמרת נכללת
  assert.equal(occurrenceDates("2026-11-02", 1)[0], "2026-11-02");
});

test("חודש עם ארבעה מופעים וחודש עם חמישה: ספירה לפי הלוח האמיתי", () => {
  // נובמבר 2026: ימי ראשון בתאריכים 1, 8, 15, 22, 29 (חמישה). דצמבר 2026: 6, 13, 20, 27 (ארבעה)
  const byMonth = groupByMonth(occurrenceDates("2026-11-01", 0).map((date) => ({ date })));
  assert.equal(byMonth.get("2026-11")!.length, 5);
  assert.equal(byMonth.get("2026-12")!.length, 4);
  assert.equal(byMonth.get("2027-01")!.length, 5); // 3, 10, 17, 24, 31
  assert.equal(monthAmountAgorot("MORNING", byMonth.get("2026-11")!.length), 83200);
  assert.equal(monthAmountAgorot("MORNING", byMonth.get("2026-12")!.length), 66560);
});

test("התחלה באמצע החודש: החודש הראשון חלקי, ושלושה חודשי חיוב בלבד", () => {
  const dates = occurrenceDates("2026-11-18", 0); // ימי ראשון מ-22.11
  const byMonth = groupByMonth(dates.map((date) => ({ date })));
  assert.deepEqual([...byMonth.keys()], ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(byMonth.get("2026-11")!.map((x) => x.date), ["2026-11-22", "2026-11-29"]);
});

test("מעבר שנה: מופעים של ינואר שייכים לחודש 2027-01", () => {
  const dates = occurrenceDates("2026-12-20", 3);
  assert.ok(dates.some((d) => d.startsWith("2027-01")));
  assert.ok(dates.every((d) => d >= "2026-12-20" && d <= "2027-02-28"));
});

test("שעון קיץ/חורף: שעות המשמרת נשארות בשעון קיר ירושלמי בכל מופע", () => {
  // מעבר לחורף: 25.10.2026 (יום ראשון); מעבר לקיץ: 27.3.2026 (יום שישי)
  const cases: [string, string, number, number][] = [
    ["2026-10-24", "MORNING", 8 * 60, 12 * 60], // שבת-לפני: תאריך רגיל
    ["2026-10-25", "MORNING", 8 * 60, 12 * 60], // יום המעבר עצמו
    ["2026-10-26", "NOON", 12 * 60 + 15, 16 * 60],
    ["2026-03-26", "EVENING", 20 * 60 + 15, 23 * 60],
    ["2026-03-27", "AFTERNOON", 16 * 60 + 15, 20 * 60], // יום המעבר לקיץ
    ["2026-03-29", "EVENING", 20 * 60 + 15, 23 * 60],
  ];
  for (const [date, windowId, startMin, endMin] of cases) {
    const { startTime, endTime } = occurrenceTimes(date, windowId as never);
    assert.deepEqual([jerusalemParts(startTime).date, jerusalemParts(startTime).minutes], [date, startMin], `${date} ${windowId} התחלה`);
    assert.deepEqual([jerusalemParts(endTime).date, jerusalemParts(endTime).minutes], [date, endMin], `${date} ${windowId} סיום`);
  }
  // המרווח בין שני מופעים עוקבים משתנה ב-UTC בגלל המעבר, אך שעת הקיר זהה
  const before = occurrenceTimes("2026-10-18", "MORNING").startTime.getTime();
  const after = occurrenceTimes("2026-10-25", "MORNING").startTime.getTime();
  assert.equal(after - before, 7 * 24 * 3600_000 + 3600_000, "שבוע + שעה (חזרה לשעון חורף)");
});

test("אימות תאריך התחלה: פורמט, עבר, וטווח קדימה", () => {
  assert.equal(validateStartDate("2026-11-18", "2026-11-18"), null);
  assert.equal(validateStartDate("2026-12-19", "2026-11-18"), null); // 31 יום
  assert.match(validateStartDate("2026-12-20", "2026-11-18")!, /עד 31 ימים/);
  assert.match(validateStartDate("2026-11-17", "2026-11-18")!, /בעבר/);
  for (const bad of ["", "2026-13-01", "2026-02-30", "18/11/2026", "2026-1-1"]) assert.match(validateStartDate(bad, "2026-11-18")!, /לא תקין/, bad);
});

test("יום שבוע לא תקין למשמרת (שבת) נדחה", () => {
  assert.throws(() => occurrenceDates("2026-11-18", 6), RangeError);
  assert.throws(() => occurrenceDates("2026-11-18", -1), RangeError);
});
