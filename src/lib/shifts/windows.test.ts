import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWindowInputs, windowLabelOf, type WindowInput } from "@/lib/shifts/windows";

// אימות ותמחור של משבצות משמרת: פונקציות טהורות, ללא מסד נתונים.

const base = (over: Partial<WindowInput> = {}): WindowInput => ({ name: "בוקר", startMinutes: 7 * 60, endMinutes: 11 * 60, monthlyPriceShekel: 480, active: true, ...over });

test("תווית משבצת: שם ושעות", () => {
  assert.equal(windowLabelOf({ name: "בוקר", startMinutes: 7 * 60, endMinutes: 11 * 60 }), "בוקר 07:00–11:00");
  assert.equal(windowLabelOf({ name: "ערב", startMinutes: 19 * 60 + 15, endMinutes: 23 * 60 }), "ערב 19:15–23:00");
});

test("אימות משבצות: רשימה תקינה עוברת, משבצות צמודות (11:00 סיום והתחלה) מותרות", () => {
  assert.equal(validateWindowInputs([base(), base({ name: "צהריים", startMinutes: 11 * 60, endMinutes: 15 * 60, monthlyPriceShekel: 525 })]), null);
});

test("אימות משבצות: שם, שעות, מחיר, חפיפה ופעילות", () => {
  assert.match(validateWindowInputs([])!, /מספר המשבצות/);
  assert.match(validateWindowInputs([base({ name: "  " })])!, /שם משבצת/);
  assert.match(validateWindowInputs([base({ name: "x".repeat(41) })])!, /שם משבצת/);
  assert.match(validateWindowInputs([base({ startMinutes: 7 * 60 + 5 })])!, /קפיצות/);
  assert.match(validateWindowInputs([base({ endMinutes: 25 * 60 })])!, /קפיצות/);
  assert.match(validateWindowInputs([base({ startMinutes: 11 * 60, endMinutes: 11 * 60 })])!, /אחרי שעת ההתחלה/);
  assert.match(validateWindowInputs([base({ startMinutes: 12 * 60, endMinutes: 11 * 60 })])!, /אחרי שעת ההתחלה/);
  for (const bad of [0, -5, 10.5, NaN, 100_001]) assert.match(validateWindowInputs([base({ monthlyPriceShekel: bad })])!, /מחיר חודשי/, String(bad));
  assert.match(validateWindowInputs([base(), base({ name: "חופפת", startMinutes: 10 * 60, endMinutes: 14 * 60 })])!, /חופפות/);
  assert.match(validateWindowInputs([base({ active: false })])!, /לפחות משבצת פעילה/);
  // משבצת מושבתת אינה נבדקת לחפיפה
  assert.equal(validateWindowInputs([base(), base({ name: "ישנה", startMinutes: 8 * 60, endMinutes: 12 * 60, active: false })]), null);
});

test("משבצת המסתיימת בדיוק בחצות (24:00) תקינה — תומך במשמרת 20:15–24:00", () => {
  const night = base({ name: "לילה", startMinutes: 20 * 60 + 15, endMinutes: 24 * 60 });
  assert.equal(validateWindowInputs([night]), null);
  assert.equal(validateWindowInputs([base(), night]), null); // אינה חופפת למשבצת אחרת (07:00–11:00)
});
