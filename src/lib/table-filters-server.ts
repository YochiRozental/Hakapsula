import { z } from "zod";
import type { Filter, FieldType, Sort, SortDir } from "@/lib/table-filters";
import { isValidIsoDate } from "@/lib/table-filters";
import { jerusalemDayEnd, jerusalemDayStart } from "@/lib/jerusalem-time";

// תרגום חיפוש ופילטרים מהלקוח לתנאי Prisma. רק שדות שהוגדרו ב-ServerField מותרים — כל השאר נדחה,
// כך שהלקוח לא יכול לסנן לפי שדות רגישים או שלא הוגדרו במפורש.

type Where = Record<string, unknown>;

export type ServerField = {
  type: FieldType;
  /** נתיב לשדה במודל, למשל ["user", "name"] */
  path?: string[];
  /** שדה מחושב (למשל ספירת יחסים) שאי אפשר לבטא ישירות ב-where */
  build?: (filter: Filter) => Promise<Where> | Where;
};

const filterSchema = z.object({
  key: z.string().max(40),
  op: z.enum([
    "contains", "equals", "startsWith", "eq", "gt", "lt", "between", "before", "after", "in", "is", "empty", "notEmpty",
  ]),
  value: z.string().max(200).optional(),
  value2: z.string().max(200).optional(),
  values: z.array(z.string().max(60)).max(30).optional(),
});

const MAX_FILTERS = 20;

export type ListQuery = {
  search: string;
  filters: Filter[];
  sort: Sort | null;
  page: number;
  pageSize: number;
};

export function parseListQuery(searchParams: URLSearchParams): ListQuery {
  const search = (searchParams.get("q") ?? searchParams.get("search") ?? "").trim().slice(0, 100);

  let filters: Filter[] = [];
  const raw = searchParams.get("filters");
  if (raw) {
    try {
      const parsed = z.array(filterSchema).max(MAX_FILTERS).safeParse(JSON.parse(raw));
      if (parsed.success) filters = parsed.data;
    } catch {
      // JSON פגום — מתעלמים מהפילטרים
    }
  }

  const sortKey = searchParams.get("sort");
  const sortDir = searchParams.get("dir");
  const sort: Sort | null =
    sortKey && sortKey.length <= 40 && (sortDir === "asc" || sortDir === "desc") ? { key: sortKey, dir: sortDir } : null;

  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("pageSize") ?? "50", 10) || 50));
  return { search, filters, sort, page, pageSize };
}

function nest(path: string[], leaf: unknown): Where {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), leaf) as Where;
}

// גבולות יום לפי שעון ישראל (לא לפי אזור הזמן של השרת)
const dayStart = jerusalemDayStart;
const dayEnd = jerusalemDayEnd;

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** תנאי על ערך של שדה (leaf) לפי סוג השדה והאופרטור. null = הפילטר לא תקין ומתעלמים ממנו */
function leafCondition(type: FieldType, f: Filter): unknown | null {
  switch (type) {
    case "text": {
      const v = f.value?.trim();
      if (!v) return null;
      if (f.op === "contains" || f.op === "equals" || f.op === "startsWith") {
        return { [f.op]: v, mode: "insensitive" };
      }
      return null;
    }
    case "number": {
      const a = toNumber(f.value);
      const b = toNumber(f.value2);
      if (f.op === "eq") return a === null ? null : { equals: a };
      if (f.op === "gt") return a === null ? null : { gt: a };
      if (f.op === "lt") return a === null ? null : { lt: a };
      if (f.op === "between") {
        if (a === null && b === null) return null;
        return { ...(a !== null && { gte: a }), ...(b !== null && { lte: b }) };
      }
      return null;
    }
    case "date": {
      const a = f.value && isValidIsoDate(f.value) ? f.value : null;
      const b = f.value2 && isValidIsoDate(f.value2) ? f.value2 : null;
      if (f.op === "before") return a ? { lt: dayStart(a) } : null;
      if (f.op === "after") return a ? { gt: dayEnd(a) } : null;
      if (f.op === "between") {
        if (!a && !b) return null;
        return { ...(a && { gte: dayStart(a) }), ...(b && { lte: dayEnd(b) }) };
      }
      return null;
    }
    case "select":
      return f.op === "in" && f.values?.length ? { in: f.values } : null;
    case "boolean":
      return f.op === "is" && (f.value === "true" || f.value === "false") ? { equals: f.value === "true" } : null;
  }
}

async function fieldCondition(field: ServerField, f: Filter): Promise<Where | null> {
  if (field.build) return field.build(f);
  if (!field.path) return null;

  if (f.op === "empty" || f.op === "notEmpty") {
    // טקסט נחשב ריק גם כמחרוזת ריקה
    const isText = field.type === "text";
    if (f.op === "empty") {
      return isText
        ? { OR: [nest(field.path, null), nest(field.path, "")] }
        : nest(field.path, null);
    }
    return isText
      ? { AND: [{ NOT: nest(field.path, null) }, { NOT: nest(field.path, "") }] }
      : { NOT: nest(field.path, null) };
  }

  const leaf = leafCondition(field.type, f);
  return leaf === null ? null : nest(field.path, leaf);
}

/**
 * בונה where משולב (AND) מחיפוש חופשי ומפילטרים.
 * חיפוש חופשי: כל מילה חייבת להופיע באחד משדות החיפוש (ללא תלות באותיות גדולות/קטנות).
 */
export async function buildWhere(
  query: Pick<ListQuery, "search" | "filters">,
  config: { searchPaths: string[][]; fields: Record<string, ServerField> },
): Promise<Where> {
  const and: Where[] = [];

  for (const word of query.search.split(/\s+/).filter(Boolean)) {
    and.push({
      OR: config.searchPaths.map((path) => nest(path, { contains: word, mode: "insensitive" })),
    });
  }

  // פילטר אחד לכל שדה; כפילויות מתעלמות מהאחרון
  const seen = new Set<string>();
  for (const f of query.filters) {
    const field = Object.hasOwn(config.fields, f.key) ? config.fields[f.key] : undefined;
    if (!field || seen.has(f.key)) continue;
    seen.add(f.key);
    const condition = await fieldCondition(field, f);
    if (condition) and.push(condition);
  }

  return and.length > 0 ? { AND: and } : {};
}

// ---------- מיון ----------
// רק מפתחות שהוגדרו במפורש ב-SortField מתקבלים (Object.hasOwn) — אי אפשר להזריק שמות שדות שרירותיים.
// מיון טקסט נעשה בזיכרון עם Intl.Collator (עברית/אנגלית, ללא תלות באותיות, ערכים ריקים בסוף), כי ה-collation של המסד הוא C
// ומיין לפי ערכי בתים. מיון תאריכים, מספרים ו-enum נעשה במסד. בשני המקרים המיון מתבצע על כל התוצאות לפני הדפדוף,
// ותמיד נוסף id כמפתח משני כדי שהסדר יהיה יציב בין עמודים.

export type SortField = { orderBy: (dir: SortDir) => Where } | { text: string[] };

export type SortPlan =
  | { kind: "db"; orderBy: Where[] }
  | { kind: "text"; path: string[]; dir: SortDir };

export function resolveSort(sort: Sort | null, fields: Record<string, SortField>, defaultOrder: Where[]): SortPlan {
  const field = sort && Object.hasOwn(fields, sort.key) ? fields[sort.key] : undefined;
  if (!sort || !field) return { kind: "db", orderBy: [...defaultOrder, { id: "asc" }] };
  if ("text" in field) return { kind: "text", path: field.text, dir: sort.dir };
  return { kind: "db", orderBy: [field.orderBy(sort.dir), { id: "asc" }] };
}

/** select של id והשדה למיון (נתיב מקונן) — מיון טקסט טוען רק את אלה לכל התוצאות */
export function textSortSelect(path: string[]): Where {
  // בקשר (relation) ה-select חייב להיות מקונן: { user: { select: { name: true } } }
  const leaf = path.reduceRight<unknown>((acc, key, i) => (i === path.length - 1 ? { [key]: true } : { [key]: { select: acc } }), true);
  return { id: true, ...(leaf as Where) };
}

const collator = new Intl.Collator(["he", "en"], { sensitivity: "base", numeric: true });

function valueAt(row: unknown, path: string[]): string {
  const v = path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);
  return typeof v === "string" ? v.trim() : "";
}

/** מיין את כל השורות (id + שדה) ומחזיר את מזהי העמוד המבוקש ואת סך התוצאות */
export function textSortPage(
  rows: { id: string }[],
  plan: { path: string[]; dir: SortDir },
  skip: number,
  take: number,
): { ids: string[]; total: number } {
  const sign = plan.dir === "asc" ? 1 : -1;
  const sorted = rows
    .map((row) => ({ id: row.id, value: valueAt(row, plan.path) }))
    .sort((a, b) => {
      // ערכים ריקים תמיד בסוף, בשני כיווני המיון
      if (!a.value !== !b.value) return a.value ? -1 : 1;
      const c = a.value && b.value ? collator.compare(a.value, b.value) * sign : 0;
      return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return { ids: sorted.slice(skip, skip + take).map((r) => r.id), total: sorted.length };
}

/** מחזיר את השורות לפי סדר המזהים */
export function orderByIds<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}
