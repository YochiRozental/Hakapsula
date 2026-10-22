// סינון טבלאות ניהול: הגדרות משותפות ללקוח ולשרת (ללא תלות ב-React או ב-Prisma).
// הלקוח בונה פילטרים ושולח אותם כ-JSON; השרת מאמת ומתרגם אותם לתנאי Prisma (table-filters-server.ts).

export type FieldType = "text" | "number" | "date" | "select" | "boolean";

export type FieldOption = { value: string; label: string };

/** הגדרת עמודה לסינון (צד לקוח, כולל תוויות להצגה) */
export type FilterField = {
  key: string;
  label: string;
  type: FieldType;
  /** select בלבד: הערכים האמיתיים (value) והתווית שמוצגת (label) */
  options?: FieldOption[];
  /** מאפשר סינון לפי ריק / לא ריק */
  nullable?: boolean;
};

export type FilterOp =
  | "contains"
  | "equals"
  | "startsWith"
  | "eq"
  | "gt"
  | "lt"
  | "between"
  | "before"
  | "after"
  | "in"
  | "is"
  | "empty"
  | "notEmpty";

export type Filter = {
  key: string;
  op: FilterOp;
  value?: string;
  value2?: string;
  values?: string[];
};

export const OP_LABELS: Record<FilterOp, string> = {
  contains: "מכיל",
  equals: "שווה ל",
  startsWith: "מתחיל ב",
  eq: "שווה ל",
  gt: "גדול מ",
  lt: "קטן מ",
  between: "בטווח",
  before: "לפני",
  after: "אחרי",
  in: "אחד מ",
  is: "הוא",
  empty: "ריק",
  notEmpty: "לא ריק",
};

const EMPTY_OPS: FilterOp[] = ["empty", "notEmpty"];

const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  text: ["contains", "equals", "startsWith"],
  number: ["eq", "gt", "lt", "between"],
  date: ["between", "after", "before"],
  select: ["in"],
  boolean: ["is"],
};

export function opsForField(field: Pick<FilterField, "type" | "nullable">): FilterOp[] {
  const ops = OPS_BY_TYPE[field.type];
  return field.nullable ? [...ops, ...EMPTY_OPS] : ops;
}

export function defaultOp(field: Pick<FilterField, "type">): FilterOp {
  return OPS_BY_TYPE[field.type][0];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** האם הפילטר מלא מספיק כדי להשפיע על התוצאות (שדה ריק בטופס = לא פעיל) */
export function isFilterActive(filter: Filter): boolean {
  if (EMPTY_OPS.includes(filter.op)) return true;
  const v = filter.value?.trim() ?? "";
  const v2 = filter.value2?.trim() ?? "";
  switch (filter.op) {
    case "in":
      return (filter.values?.length ?? 0) > 0;
    case "is":
      return v === "true" || v === "false";
    case "between":
      // טווח פתוח מותר: מספיק קצה אחד (מתאריך / עד תאריך)
      return v !== "" || v2 !== "";
    default:
      return v !== "";
  }
}

export function activeFilters(filters: Record<string, Filter>): Filter[] {
  return Object.values(filters).filter(isFilterActive);
}

/** עמוד תקין: אם העמוד המבוקש חורג מכמות העמודים (למשל אחרי מחיקה), חוזרים לעמוד האחרון */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), pages);
}

export function isValidIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

/** תיאור קצר של פילטר פעיל להצגה בתגית */
export function describeFilter(field: FilterField, filter: Filter): string {
  const label = field.label;
  if (filter.op === "empty") return `${label}: ריק`;
  if (filter.op === "notEmpty") return `${label}: לא ריק`;
  const v = filter.value ?? "";
  const v2 = filter.value2 ?? "";
  switch (field.type) {
    case "select": {
      const names = (filter.values ?? []).map((x) => field.options?.find((o) => o.value === x)?.label ?? x);
      return `${label}: ${names.join(", ")}`;
    }
    case "boolean":
      return `${label}: ${v === "true" ? "כן" : "לא"}`;
    case "date":
    case "number":
      if (filter.op === "between") {
        if (v && v2) return `${label}: ${v === v2 ? formatValue(field, v) : `${formatValue(field, v)} – ${formatValue(field, v2)}`}`;
        return v ? `${label}: מ-${formatValue(field, v)}` : `${label}: עד ${formatValue(field, v2)}`;
      }
      return `${label} ${OP_LABELS[filter.op]} ${formatValue(field, v)}`;
    default:
      return `${label} ${OP_LABELS[filter.op]} "${v}"`;
  }
}

function formatValue(field: FilterField, value: string): string {
  if (field.type !== "date" || !isValidIsoDate(value)) return value;
  const [y, m, d] = value.split("-");
  return `${d}/${m}/${y}`;
}

export type SortDir = "asc" | "desc";
export type Sort = { key: string; dir: SortDir };

/** מחזור המיון בלחיצה על כותרת: עולה ← יורד ← ברירת מחדל (null) */
export function nextSort(current: Sort | null, key: string): Sort | null {
  if (!current || current.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

/** פרמטרים של בקשת רשימה לשרת: חיפוש חופשי, פילטרים פעילים ודפדוף */
export function buildListParams(opts: {
  search: string;
  filters: Filter[];
  sort?: Sort | null;
  page: number;
  pageSize: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  const q = opts.search.trim();
  if (q) params.set("q", q);
  if (opts.filters.length > 0) params.set("filters", JSON.stringify(opts.filters));
  if (opts.sort) {
    params.set("sort", opts.sort.key);
    params.set("dir", opts.sort.dir);
  }
  params.set("page", String(opts.page));
  params.set("pageSize", String(opts.pageSize));
  return params;
}
