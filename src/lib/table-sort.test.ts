import assert from "node:assert/strict";
import { test } from "node:test";
import { orderByIds, parseListQuery, resolveSort, textSortPage, type SortField } from "./table-filters-server";
import { buildListParams, nextSort } from "./table-filters";

test("מחזור מיון בלחיצה: עולה ← יורד ← ברירת מחדל, ועמודה חדשה מתחילה בעולה", () => {
  const asc = nextSort(null, "name");
  assert.deepEqual(asc, { key: "name", dir: "asc" });
  const desc = nextSort(asc, "name");
  assert.deepEqual(desc, { key: "name", dir: "desc" });
  assert.equal(nextSort(desc, "name"), null);
  assert.deepEqual(nextSort(desc, "email"), { key: "email", dir: "asc" });
});

test("buildListParams שולח מיון, ומעבר עמוד שומר עליו ועל המסננים", () => {
  const filters = [{ key: "status", op: "in" as const, values: ["APPROVED"] }];
  const sort = { key: "name", dir: "desc" as const };
  const p1 = buildListParams({ search: "דני", filters, sort, page: 1, pageSize: 50 });
  const p2 = buildListParams({ search: "דני", filters, sort, page: 2, pageSize: 50 });
  for (const p of [p1, p2]) {
    assert.equal(p.get("sort"), "name");
    assert.equal(p.get("dir"), "desc");
    assert.equal(p.get("q"), "דני");
    assert.equal(p.get("filters"), JSON.stringify(filters));
  }
  assert.equal(p2.get("page"), "2");
  assert.equal(buildListParams({ search: "", filters: [], page: 1, pageSize: 50 }).has("sort"), false);
});

test("parseListQuery: מיון תקין בלבד", () => {
  assert.deepEqual(parseListQuery(new URLSearchParams("sort=name&dir=asc")).sort, { key: "name", dir: "asc" });
  assert.equal(parseListQuery(new URLSearchParams("sort=name&dir=sideways")).sort, null);
  assert.equal(parseListQuery(new URLSearchParams("sort=name")).sort, null);
  assert.equal(parseListQuery(new URLSearchParams(`sort=${"x".repeat(41)}&dir=asc`)).sort, null);
});

const fields: Record<string, SortField> = {
  name: { text: ["name"] },
  createdAt: { orderBy: (dir) => ({ createdAt: dir }) },
};
const fallback = [{ createdAt: "desc" }];

test("resolveSort: רק שדות מורשים; שמות שרירותיים ושמות של אבטיפוס נדחים", () => {
  assert.deepEqual(resolveSort({ key: "createdAt", dir: "asc" }, fields, fallback), {
    kind: "db",
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(resolveSort({ key: "name", dir: "desc" }, fields, fallback), { kind: "text", path: ["name"], dir: "desc" });
  const def = { kind: "db", orderBy: [{ createdAt: "desc" }, { id: "asc" }] };
  for (const key of ["passwordHash", "idNumber", "__proto__", "constructor", "toString", "name; drop table"]) {
    assert.deepEqual(resolveSort({ key, dir: "asc" }, fields, fallback), def, key);
  }
  assert.deepEqual(resolveSort(null, fields, fallback), def);
});

const names = (rows: { id: string; name: string | null }[], ids: string[]) =>
  ids.map((id) => rows.find((r) => r.id === id)?.name);

test("מיון טקסט: עברית לפני לטינית, ללא תלות באותיות, מספרים מספרית", () => {
  const rows = [
    { id: "1", name: "בני" },
    { id: "2", name: "alice" },
    { id: "3", name: "Bob" },
    { id: "4", name: "אבי" },
    { id: "5", name: "user10" },
    { id: "6", name: "user2" },
  ];
  const { ids } = textSortPage(rows, { path: ["name"], dir: "asc" }, 0, 50);
  assert.deepEqual(names(rows, ids), ["אבי", "בני", "alice", "Bob", "user2", "user10"]);
  const desc = textSortPage(rows, { path: ["name"], dir: "desc" }, 0, 50);
  assert.deepEqual(names(rows, desc.ids), ["user10", "user2", "Bob", "alice", "בני", "אבי"]);
});

test("ערכים ריקים תמיד בסוף, בשני הכיוונים", () => {
  const rows = [
    { id: "1", name: null },
    { id: "2", name: "ב" },
    { id: "3", name: "  " },
    { id: "4", name: "א" },
  ];
  const asc = textSortPage(rows, { path: ["name"], dir: "asc" }, 0, 50).ids;
  const desc = textSortPage(rows, { path: ["name"], dir: "desc" }, 0, 50).ids;
  assert.deepEqual(asc, ["4", "2", "1", "3"]);
  assert.deepEqual(desc, ["2", "4", "1", "3"]);
});

test("מיון נשען על שדה מקונן (user.name)", () => {
  const rows = [
    { id: "a", user: { name: "ציפ" } },
    { id: "b", user: { name: "אבי" } },
  ];
  assert.deepEqual(textSortPage(rows, { path: ["user", "name"], dir: "asc" }, 0, 10).ids, ["b", "a"]);
});

test("סדר יציב עם ערכים זהים: דפדוף בין עמודים בלי כפילויות או דילוגים, בשני הכיוונים", () => {
  // 120 שורות עם רק 4 ערכים שונים — הרבה תיקו
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `id${String(i).padStart(3, "0")}`, name: ["ד", "א", "ג", "ב"][i % 4] }));
  for (const dir of ["asc", "desc"] as const) {
    const pageSize = 50;
    const seen: string[] = [];
    let total = 0;
    for (let page = 1; page <= 3; page++) {
      const r = textSortPage(rows, { path: ["name"], dir }, (page - 1) * pageSize, pageSize);
      total = r.total;
      seen.push(...r.ids);
    }
    assert.equal(total, 120);
    assert.equal(new Set(seen).size, 120, "בלי כפילויות");
    assert.deepEqual(seen, textSortPage(rows, { path: ["name"], dir }, 0, 1000).ids, "העמודים מרכיבים את הרשימה המלאה");
  }
});

test("סינון + מיון + דפדוף: המיון חל על כל התוצאות המסוננות לפני החיתוך לעמודים", () => {
  const all = Array.from({ length: 90 }, (_, i) => ({ id: `u${String(i).padStart(2, "0")}`, name: `לקוח ${90 - i}`, status: i % 3 === 0 ? "BLOCKED" : "APPROVED" }));
  const filtered = all.filter((r) => r.status === "APPROVED"); // 60 תוצאות
  const p1 = textSortPage(filtered, { path: ["name"], dir: "asc" }, 0, 50);
  const p2 = textSortPage(filtered, { path: ["name"], dir: "asc" }, 50, 50);
  assert.equal(p1.total, 60);
  assert.equal(p2.ids.length, 10);
  // מספרית: "לקוח 2" לפני "לקוח 10", והעמוד הראשון מתחיל מהקטן ביותר בכלל התוצאות — לא רק בעמוד
  assert.equal(names(filtered, [p1.ids[0]])[0], filtered.map((r) => r.name).sort((a, b) => a.localeCompare(b, "he", { numeric: true }))[0]);
  assert.equal(new Set([...p1.ids, ...p2.ids]).size, 60);
  assert.ok(![...p1.ids, ...p2.ids].some((id) => all.find((r) => r.id === id)?.status === "BLOCKED"));
});

test("orderByIds משחזר את סדר המזהים", () => {
  assert.deepEqual(orderByIds([{ id: "b" }, { id: "a" }, { id: "c" }], ["c", "a", "b"]).map((r) => r.id), ["c", "a", "b"]);
});

test("textSortSelect: select מקונן ליחסים", async () => {
  const { textSortSelect } = await import("./table-filters-server");
  assert.deepEqual(textSortSelect(["name"]), { id: true, name: true });
  assert.deepEqual(textSortSelect(["user", "name"]), { id: true, user: { select: { name: true } } });
});
