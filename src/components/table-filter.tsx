"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  OP_LABELS,
  activeFilters,
  defaultOp,
  describeFilter,
  opsForField,
  type Filter,
  type FilterField,
  type FilterOp,
} from "@/lib/table-filters";
import { Icon } from "@/components/ui";

const DEBOUNCE_MS = 300;

/**
 * מצב חיפוש + סינון מתקדם + דפדוף של טבלה. המצב חי אצל הדף (לא בפאנל), ולכן פתיחה וסגירה של הפאנל לא מאפסות אותו.
 * `applied` הוא הערך אחרי debounce — זה מה ששולחים לשרת.
 */
export function useTableFilters(initial: Record<string, Filter> = {}) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(initial);
  const active = useMemo(() => activeFilters(filters), [filters]);

  const [applied, setApplied] = useState({ search: "", filters: activeFilters(initial) });
  const appliedKey = JSON.stringify(applied);
  useEffect(() => {
    const handle = setTimeout(() => {
      setApplied((prev) => {
        const next = { search: search.trim(), filters: active };
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, active]);

  // חזרה לעמוד 1 בכל שינוי בחיפוש/סינון, בלי אפקט נוסף ובלי בקשה כפולה
  const [pageState, setPageState] = useState({ key: appliedKey, page: 1 });
  const page = pageState.key === appliedKey ? pageState.page : 1;
  const setPage = (p: number) => setPageState({ key: appliedKey, page: p });

  return { search, setSearch, filters, setFilters, active, applied, appliedKey, page, setPage };
}

export type TableFilterState = ReturnType<typeof useTableFilters>;

export function TableFilterBar({
  state,
  fields,
  searchPlaceholder,
  searchLabel,
  total,
  actions,
}: {
  state: TableFilterState;
  fields: FilterField[];
  searchPlaceholder: string;
  searchLabel: string;
  /** מספר התוצאות הכולל (null בזמן טעינה) */
  total: number | null;
  actions?: ReactNode;
}) {
  const { search, setSearch, filters, setFilters, active } = state;
  const [open, setOpen] = useState(false);
  const searchActive = search.trim() !== "";
  const activeCount = active.length + (searchActive ? 1 : 0);
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  function removeFilter(key: string) {
    const next = { ...filters };
    delete next[key];
    setFilters(next);
  }

  function clearAll() {
    setFilters({});
    setSearch("");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-56">
          <Icon name="search" className="w-4 h-4 text-stone-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            className="field bg-white! pr-10!"
          />
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`btn ${open ? "btn-primary" : "btn-secondary"}`}
        >
          <Icon name="filter" className="w-4 h-4" />
          סינון מתקדם
          {active.length > 0 && (
            <span className="rounded-full bg-brand-50 text-brand-700 text-xs font-bold tabular-nums min-w-5 h-5 px-1.5 inline-flex items-center justify-center">
              {active.length}
            </span>
          )}
        </button>
        {actions}
      </div>

      {open && (
        <div className="card p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((field) => (
              <FieldEditor
                key={field.key}
                field={field}
                filter={filters[field.key]}
                onChange={(f) => setFilters({ ...filters, [field.key]: f })}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={clearAll} disabled={activeCount === 0} className="btn btn-ghost btn-sm">
              נקה הכול
            </button>
            <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary btn-sm">
              סגירה
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 min-h-7">
        {searchActive && <Chip label={`חיפוש: "${search.trim()}"`} onRemove={() => setSearch("")} />}
        {active.map((f) => {
          const field = fieldByKey.get(f.key);
          return field ? <Chip key={f.key} label={describeFilter(field, f)} onRemove={() => removeFilter(f.key)} /> : null;
        })}
        {activeCount > 0 && (
          <>
            <span className="text-xs text-stone-500 tabular-nums">{activeCount} מסננים פעילים</span>
            <button type="button" onClick={clearAll} className="text-xs font-semibold text-brand-700 hover:underline">
              נקה הכול
            </button>
          </>
        )}
        {total !== null && (
          <span className="text-xs text-stone-500 tabular-nums me-auto" role="status" aria-live="polite">
            {total === 0 ? "אין תוצאות" : total === 1 ? "תוצאה אחת" : `${total} תוצאות`}
          </span>
        )}
      </div>
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="badge bg-brand-50 text-brand-700 gap-1.5 pe-1.5">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`הסרת מסנן: ${label}`}
        className="rounded-full hover:bg-brand-100 w-4 h-4 inline-flex items-center justify-center"
      >
        <Icon name="x" className="w-3 h-3" />
      </button>
    </span>
  );
}

function FieldEditor({
  field,
  filter,
  onChange,
}: {
  field: FilterField;
  filter: Filter | undefined;
  onChange: (f: Filter) => void;
}) {
  const ops = opsForField(field);
  const op: FilterOp = filter?.op ?? defaultOp(field);
  const id = `filter-${field.key}`;
  const base: Filter = { key: field.key, op, value: filter?.value, value2: filter?.value2, values: filter?.values };
  const set = (patch: Partial<Filter>) => onChange({ ...base, ...patch });
  const isEmptyOp = op === "empty" || op === "notEmpty";

  return (
    <div>
      <label htmlFor={id} className="field-label">{field.label}</label>
      <div className="space-y-2">
        {ops.length > 1 && (
          <select id={id} value={op} onChange={(e) => set({ op: e.target.value as FilterOp })} className="field" aria-label={`${field.label} — סוג סינון`}>
            {ops.map((o) => (
              <option key={o} value={o}>{OP_LABELS[o]}</option>
            ))}
          </select>
        )}
        {!isEmptyOp && <ValueInputs field={field} id={ops.length > 1 ? undefined : id} base={base} set={set} />}
      </div>
    </div>
  );
}

function ValueInputs({
  field,
  id,
  base,
  set,
}: {
  field: FilterField;
  id: string | undefined;
  base: Filter;
  set: (patch: Partial<Filter>) => void;
}) {
  switch (field.type) {
    case "text":
      return (
        <input id={id} value={base.value ?? ""} onChange={(e) => set({ value: e.target.value })} className="field" aria-label={field.label} />
      );
    case "number":
      return (
        <div className="flex items-center gap-2">
          <input id={id} type="number" inputMode="numeric" value={base.value ?? ""} onChange={(e) => set({ value: e.target.value })} className="field" aria-label={`${field.label} — ערך`} />
          {base.op === "between" && (
            <>
              <span className="text-stone-400 text-sm">–</span>
              <input type="number" inputMode="numeric" value={base.value2 ?? ""} onChange={(e) => set({ value2: e.target.value })} className="field" aria-label={`${field.label} — עד`} />
            </>
          )}
        </div>
      );
    case "date":
      return base.op === "between" ? (
        <div className="flex items-center gap-2">
          <input id={id} type="date" value={base.value ?? ""} max={base.value2 || undefined} onChange={(e) => set({ value: e.target.value })} className="field" aria-label={`${field.label} — מתאריך`} />
          <span className="text-stone-400 text-sm">–</span>
          <input type="date" value={base.value2 ?? ""} min={base.value || undefined} onChange={(e) => set({ value2: e.target.value })} className="field" aria-label={`${field.label} — עד תאריך`} />
        </div>
      ) : (
        <input id={id} type="date" value={base.value ?? ""} onChange={(e) => set({ value: e.target.value })} className="field" aria-label={field.label} />
      );
    case "select": {
      const selected = new Set(base.values ?? []);
      return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={field.label}>
          {field.options?.map((o) => {
            const on = selected.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(o.value);
                  else next.add(o.value);
                  set({ values: [...next] });
                }}
                className={`badge cursor-pointer border ${
                  on ? "bg-brand-600 text-white border-brand-600" : "bg-white text-stone-600 border-cream-300 hover:border-bronze-300"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex gap-1.5" role="group" aria-label={field.label}>
          {[
            { v: undefined, label: "הכול" },
            { v: "true", label: "כן" },
            { v: "false", label: "לא" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={base.value === o.v}
              onClick={() => set({ op: "is", value: o.v })}
              className={`badge cursor-pointer border ${
                base.value === o.v ? "bg-brand-600 text-white border-brand-600" : "bg-white text-stone-600 border-cream-300 hover:border-bronze-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
  }
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-sm text-stone-600">
      <span className="tabular-nums">
        {from}–{to} מתוך {total}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <Icon name="chevronRight" className="w-4 h-4" />
          הקודם
        </button>
        <span className="tabular-nums">{page} / {pages}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          הבא
          <Icon name="chevronLeft" className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
