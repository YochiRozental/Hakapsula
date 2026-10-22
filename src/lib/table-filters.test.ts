import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWhere, parseListQuery, type ServerField } from "./table-filters-server";
import { clampPage, describeFilter, isFilterActive } from "./table-filters";
import { jerusalemDayEnd, jerusalemDayStart, jerusalemTodayIso } from "./jerusalem-time";

const fields: Record<string, ServerField> = {
  name: { type: "text", path: ["user", "name"] },
  phone: { type: "text", path: ["phone"] },
  when: { type: "date", path: ["startTime"] },
  count: { type: "number", path: ["count"] },
  room: { type: "select", path: ["room", "key"] },
  active: { type: "boolean", path: ["active"] },
};
const config = { searchPaths: [["name"], ["email"]], fields };

test("חיפוש חופשי: כל מילה חייבת להופיע באחד השדות", async () => {
  const where = await buildWhere({ search: "דני cohen", filters: [] }, config);
  assert.deepEqual(where, {
    AND: [
      { OR: [{ name: { contains: "דני", mode: "insensitive" } }, { email: { contains: "דני", mode: "insensitive" } }] },
      { OR: [{ name: { contains: "cohen", mode: "insensitive" } }, { email: { contains: "cohen", mode: "insensitive" } }] },
    ],
  });
});

test("פילטרים משולבים ב-AND ושדות לא מוכרים נדחים", async () => {
  const where = await buildWhere(
    {
      search: "",
      filters: [
        { key: "name", op: "startsWith", value: "ab" },
        { key: "room", op: "in", values: ["ROOM1", "ROOM2"] },
        { key: "idNumber", op: "equals", value: "123" },
      ],
    },
    config,
  );
  assert.deepEqual(where, {
    AND: [
      { user: { name: { startsWith: "ab", mode: "insensitive" } } },
      { room: { key: { in: ["ROOM1", "ROOM2"] } } },
    ],
  });
});

test("טווח תאריכים כולל את יום הסיום, וטווח פתוח מותר", async () => {
  const both = (await buildWhere({ search: "", filters: [{ key: "when", op: "between", value: "2026-01-01", value2: "2026-01-02" }] }, config)) as {
    AND: { startTime: { gte: Date; lte: Date } }[];
  };
  assert.equal(both.AND[0].startTime.gte.getTime(), Date.parse("2025-12-31T22:00:00Z"));
  assert.equal(both.AND[0].startTime.lte.getTime(), Date.parse("2026-01-02T21:59:59.999Z"));
  const open = (await buildWhere({ search: "", filters: [{ key: "when", op: "between", value2: "2026-01-02" }] }, config)) as {
    AND: { startTime: object }[];
  };
  assert.deepEqual(Object.keys(open.AND[0].startTime), ["lte"]);
});

test("מספר, בוליאני וריק/לא ריק", async () => {
  assert.deepEqual(await buildWhere({ search: "", filters: [{ key: "count", op: "between", value: "2", value2: "5" }] }, config), {
    AND: [{ count: { gte: 2, lte: 5 } }],
  });
  assert.deepEqual(await buildWhere({ search: "", filters: [{ key: "active", op: "is", value: "false" }] }, config), {
    AND: [{ active: { equals: false } }],
  });
  assert.deepEqual(await buildWhere({ search: "", filters: [{ key: "phone", op: "empty" }] }, config), {
    AND: [{ OR: [{ phone: null }, { phone: "" }] }],
  });
  assert.deepEqual(await buildWhere({ search: "", filters: [{ key: "phone", op: "notEmpty" }] }, config), {
    AND: [{ AND: [{ NOT: { phone: null } }, { NOT: { phone: "" } }] }],
  });
});

test("ערכים לא תקינים מתעלמים, ו-JSON פגום לא שובר", async () => {
  assert.deepEqual(await buildWhere({ search: "", filters: [{ key: "when", op: "before", value: "not-a-date" }] }, config), {});
  const q = parseListQuery(new URLSearchParams({ filters: "{bad", page: "-3", pageSize: "9999" }));
  assert.deepEqual(q, { search: "", filters: [], sort: null, page: 1, pageSize: 100 });
});

test("פילטר פעיל רק כשהוא מלא; תיאור התגית", () => {
  assert.equal(isFilterActive({ key: "a", op: "contains", value: "  " }), false);
  assert.equal(isFilterActive({ key: "a", op: "in", values: [] }), false);
  assert.equal(isFilterActive({ key: "a", op: "empty" }), true);
  assert.equal(
    describeFilter({ key: "d", label: "תאריך", type: "date" }, { key: "d", op: "between", value: "2026-01-01", value2: "2026-01-31" }),
    "תאריך: 01/01/2026 – 31/01/2026",
  );
});

test("גבולות יום לפי ירושלים: חורף (UTC+2) וקיץ (UTC+3)", () => {
  assert.equal(jerusalemDayStart("2026-01-15").toISOString(), "2026-01-14T22:00:00.000Z");
  assert.equal(jerusalemDayEnd("2026-01-15").toISOString(), "2026-01-15T21:59:59.999Z");
  assert.equal(jerusalemDayStart("2026-07-15").toISOString(), "2026-07-14T21:00:00.000Z");
  assert.equal(jerusalemDayEnd("2026-07-15").toISOString(), "2026-07-15T20:59:59.999Z");
});

test("ימי מעבר שעון: יום של 23 שעות (מרץ) ושל 25 שעות (אוקטובר)", () => {
  // 2026-03-27 (שישי) — מעבר לקיץ ב-02:00
  const spring = jerusalemDayEnd("2026-03-27").getTime() - jerusalemDayStart("2026-03-27").getTime() + 1;
  assert.equal(spring, 23 * 3600_000);
  assert.equal(jerusalemDayStart("2026-03-27").toISOString(), "2026-03-26T22:00:00.000Z");
  assert.equal(jerusalemDayEnd("2026-03-27").toISOString(), "2026-03-27T20:59:59.999Z");
  // 2026-10-25 (ראשון) — חזרה לחורף ב-02:00
  const fall = jerusalemDayEnd("2026-10-25").getTime() - jerusalemDayStart("2026-10-25").getTime() + 1;
  assert.equal(fall, 25 * 3600_000);
  assert.equal(jerusalemDayStart("2026-10-25").toISOString(), "2026-10-24T21:00:00.000Z");
  assert.equal(jerusalemDayEnd("2026-10-25").toISOString(), "2026-10-25T21:59:59.999Z");
});

test("היום הנוכחי לפי ישראל, גם כשב-UTC עדיין היום הקודם", () => {
  assert.equal(jerusalemTodayIso(new Date("2026-07-14T21:30:00Z")), "2026-07-15");
  assert.equal(jerusalemTodayIso(new Date("2026-01-14T21:30:00Z")), "2026-01-14");
  assert.equal(jerusalemTodayIso(new Date("2026-01-14T22:00:00Z")), "2026-01-15");
});

test("clampPage: חזרה לעמוד התקין האחרון", () => {
  assert.equal(clampPage(3, 101, 50), 3);
  assert.equal(clampPage(3, 100, 50), 2);
  assert.equal(clampPage(5, 0, 50), 1);
  assert.equal(clampPage(0, 10, 50), 1);
});
