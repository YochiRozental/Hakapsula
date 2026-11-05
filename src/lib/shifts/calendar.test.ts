import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  addMonthsClamped,
  billingDueDates,
  billingMonths,
  occurrenceDates,
  occurrencePriceAgorot,
  occurrenceTimes,
  periodIndexOf,
  periodKeyOf,
  sessionsInPeriod,
  shiftEndDate,
  validateStartDate,
  weekdayOf,
} from "@/lib/shifts/calendar";
import type { ShiftWindowDef } from "@/lib/shifts/windows";
import { jerusalemParts } from "@/lib/opening-hours";

// לוח שנה, תמחור ומעברי שעון של משמרות: פונקציות טהורות, ללא מסד נתונים.

// משבצות ברירת המחדל לפי המחירון המאושר (מחיר לחודש כולל מע"מ)
const W = {
  MORNING: { startMinutes: 7 * 60, endMinutes: 11 * 60, monthlyPriceAgorot: 48000 },
  NOON: { startMinutes: 11 * 60, endMinutes: 15 * 60, monthlyPriceAgorot: 52500 },
  AFTERNOON: { startMinutes: 15 * 60, endMinutes: 19 * 60, monthlyPriceAgorot: 60000 },
  EVENING: { startMinutes: 19 * 60, endMinutes: 22 * 60, monthlyPriceAgorot: 50000 },
} satisfies Record<string, Pick<ShiftWindowDef, "startMinutes" | "endMinutes" | "monthlyPriceAgorot">>;

test("הוספת חודשים: היום האחרון של החודש כשהיום אינו קיים; תמיד ביחס לתאריך המקורי ולא בשרשרת", () => {
  assert.equal(addMonthsClamped("2027-01-31", 1), "2027-02-28");
  assert.equal(addMonthsClamped("2027-01-31", 2), "2027-03-31", "לא 28.3: אין שרשרת");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29"); // שנה מעוברת
  assert.equal(addMonthsClamped("2026-08-31", 1), "2026-09-30");
  assert.equal(addMonthsClamped("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonthsClamped("2026-12-15", 2), "2027-02-15"); // מעבר שנה
});

test("שלושה חיובים בדיוק: בתאריך ההתחלה, חודש אחריו וחודשיים אחריו; אין חיוב רביעי", () => {
  assert.deepEqual(billingDueDates("2027-02-15"), ["2027-02-15", "2027-03-15", "2027-04-15"]);
  assert.deepEqual(billingDueDates("2027-01-31"), ["2027-01-31", "2027-02-28", "2027-03-31"]);
  assert.deepEqual(billingDueDates("2028-01-31"), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  assert.deepEqual(billingDueDates("2027-01-30"), ["2027-01-30", "2027-02-28", "2027-03-30"]);
  assert.deepEqual(billingDueDates("2026-12-31"), ["2026-12-31", "2027-01-31", "2027-02-28"]);
  assert.deepEqual(billingMonths("2027-01-31"), ["2027-01", "2027-02", "2027-03"]);
  for (const start of ["2026-08-31", "2027-01-29", "2027-01-30", "2027-01-31", "2028-02-29", "2026-12-31"]) {
    const due = billingDueDates(start);
    assert.equal(due.length, 3, start);
    assert.equal(new Set(billingMonths(start)).size, 3, `${start}: חודשים שונים`);
    assert.ok(due[0] < due[1] && due[1] < due[2], start);
  }
});

test("תקופה: שלושה חודשים מתאריך ההתחלה, מסתיימת ביום שלפני מועד החיוב הרביעי", () => {
  assert.equal(shiftEndDate("2027-02-15"), "2027-05-14");
  assert.equal(shiftEndDate("2026-11-01"), "2027-01-31"); // מעבר שנה
  assert.equal(shiftEndDate("2026-11-18"), "2027-02-17");
  assert.equal(shiftEndDate("2026-12-31"), "2027-03-30");
  assert.equal(shiftEndDate("2027-12-05"), "2028-03-04"); // שנה מעוברת
  assert.equal(shiftEndDate("2026-11-30"), "2027-02-27"); // 28.2 הוא מועד החיוב הרביעי המוצמד, ולכן הסיום 27.2
});

test("תקופות חיוב: איזה חיוב מכסה כל תאריך", () => {
  const start = "2027-02-15";
  const cases: [string, number][] = [["2027-02-15", 0], ["2027-03-14", 0], ["2027-03-15", 1], ["2027-04-14", 1], ["2027-04-15", 2], ["2027-05-14", 2]];
  for (const [date, index] of cases) assert.equal(periodIndexOf(start, date), index, date);
  assert.equal(periodKeyOf(start, "2027-03-20"), "2027-03");
  assert.equal(periodKeyOf("2027-01-31", "2027-02-28"), "2027-02");
});

test("מפגשים בתקופה: 4 או 5, בלי חישוב יחסי; כל המפגשים בשלושת החודשים כלולים", () => {
  const start = "2027-02-15"; // יום שני
  assert.deepEqual([0, 1, 2].map((i) => sessionsInPeriod(start, 1, i)), [4, 5, 4]); // 15,22,1,8 | 15,22,29,5,12 | 19,26,3,10
  assert.equal(occurrenceDates(start, 1).length, 13);
  for (const s of ["2026-11-18", "2027-01-31", "2028-02-29", "2026-12-31"]) {
    for (let weekday = 0; weekday <= 5; weekday++) {
      const counts = [0, 1, 2].map((i) => sessionsInPeriod(s, weekday, i));
      assert.ok(counts.every((c) => c === 4 || c === 5), `${s} ${weekday}: ${counts}`);
      assert.equal(counts.reduce((n, c) => n + c, 0), occurrenceDates(s, weekday).length, "כל המפגשים משויכים לתקופה");
    }
  }
});

test("מחיר מופע = מחיר חודשי ÷ מפגשים בתקופה; כל תקופה מסתכמת במחיר החודשי בדיוק (שקלים שלמים)", () => {
  const start = "2027-02-15";
  assert.equal(occurrencePriceAgorot(48000, start, 1, "2027-02-22"), 12000); // 480 ÷ 4
  assert.equal(occurrencePriceAgorot(48000, start, 1, "2027-03-22"), 9600); // 480 ÷ 5
  assert.equal(occurrencePriceAgorot(52500, start, 1, "2027-03-22"), 10500);
  for (const monthly of [48000, 52500, 60000, 50000, 47900, 100]) {
    for (const s of ["2027-02-15", "2027-01-31", "2028-02-29"]) {
      for (let weekday = 0; weekday <= 5; weekday++) {
        const dates = occurrenceDates(s, weekday);
        const byPeriod = new Map<string, number>();
        for (const d of dates) byPeriod.set(periodKeyOf(s, d), (byPeriod.get(periodKeyOf(s, d)) ?? 0) + occurrencePriceAgorot(monthly, s, weekday, d));
        for (const [period, sum] of byPeriod) assert.equal(sum, monthly, `${monthly} ${s} ${weekday} ${period}`);
      }
    }
  }
  assert.throws(() => occurrencePriceAgorot(-1, start, 1, "2027-02-22"), RangeError);
});

test("מופעים: ביום השבוע הנבחר בלבד, בלי כפילויות ובלי אחרי הסיום; כולל התחלה באמצע השבוע", () => {
  const dates = occurrenceDates("2026-11-18", 1); // יום שני
  assert.ok(dates.every((d) => weekdayOf(d) === 1));
  assert.equal(new Set(dates).size, dates.length);
  assert.equal(dates[0], "2026-11-23", "התחלה ביום רביעי: המופע הראשון ביום שני הבא");
  assert.ok(dates.at(-1)! <= "2027-02-17");
  assert.ok(addDays(dates.at(-1)!, 7) > "2027-02-17", "אין מופע שנשאר בתקופה");
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted);

  // התחלה בדיוק ביום המשמרת נכללת
  assert.equal(occurrenceDates("2026-11-02", 1)[0], "2026-11-02");
});

test("מעבר שנה: מופעים של ינואר שייכים לתקופת החיוב הנכונה", () => {
  const dates = occurrenceDates("2026-12-20", 3);
  assert.ok(dates.some((d) => d.startsWith("2027-01")));
  assert.ok(dates.every((d) => d >= "2026-12-20" && d <= "2027-03-19"));
  assert.equal(periodKeyOf("2026-12-20", "2027-01-19"), "2026-12");
  assert.equal(periodKeyOf("2026-12-20", "2027-01-20"), "2027-01");
});

test("שעון קיץ/חורף: שעות המשמרת נשארות בשעון קיר ירושלמי בכל מופע", () => {
  // מעבר לחורף: 25.10.2026 (יום ראשון); מעבר לקיץ: 27.3.2026 (יום שישי)
  const cases: [string, string, number, number][] = [
    ["2026-10-24", "MORNING", 7 * 60, 11 * 60], // שבת-לפני: תאריך רגיל
    ["2026-10-25", "MORNING", 7 * 60, 11 * 60], // יום המעבר עצמו
    ["2026-10-26", "NOON", 11 * 60, 15 * 60],
    ["2026-03-26", "EVENING", 19 * 60, 22 * 60],
    ["2026-03-27", "AFTERNOON", 15 * 60, 19 * 60], // יום המעבר לקיץ
    ["2026-03-29", "EVENING", 19 * 60, 22 * 60],
  ];
  for (const [date, windowId, startMin, endMin] of cases) {
    const { startTime, endTime } = occurrenceTimes(date, W[windowId as keyof typeof W]);
    assert.deepEqual([jerusalemParts(startTime).date, jerusalemParts(startTime).minutes], [date, startMin], `${date} ${windowId} התחלה`);
    assert.deepEqual([jerusalemParts(endTime).date, jerusalemParts(endTime).minutes], [date, endMin], `${date} ${windowId} סיום`);
  }
  // המרווח בין שני מופעים עוקבים משתנה ב-UTC בגלל המעבר, אך שעת הקיר זהה
  const before = occurrenceTimes("2026-10-18", W.MORNING).startTime.getTime();
  const after = occurrenceTimes("2026-10-25", W.MORNING).startTime.getTime();
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
