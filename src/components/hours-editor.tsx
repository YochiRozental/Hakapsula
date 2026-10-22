"use client";

import {
  ACTIVITY_LABELS,
  ACTIVITY_TYPES,
  DEFAULT_DAY_WINDOW,
  formatMinutes,
  formatWindow,
  parseTimeOption,
  STEP_MINUTES,
  type ActivityType,
  type DayInterval,
} from "@/lib/opening-hours";
import { Icon } from "@/components/ui";

export type EditRow = { start: string; end: string; activity: ActivityType };

/**
 * עריכת יום: מסלול היום (חל גם בלי חלונות: היום המלא 08:00–21:00), האם היום סגור, והחלונות המפורשים.
 * כשהיום סגור החלונות נשמרים (לא נמחקים) אך אינם פעילים.
 */
export type DayEdit = { dayActivity: ActivityType; closed: boolean; rows: EditRow[] };

/** מסלול היום בפועל: כשכל החלונות מאותו מסלול — הוא; אחרת (או בלי חלונות) — מה שנבחר ליום */
export function effectiveDayActivity({ dayActivity, rows }: Pick<DayEdit, "dayActivity" | "rows">): ActivityType {
  return rows.length > 0 && rows.every((r) => r.activity === rows[0].activity) ? rows[0].activity : dayActivity;
}

export function toEditRows(list: DayInterval[]): EditRow[] {
  return list.map((w) => ({
    start: formatMinutes(w.startMinutes),
    // שדה שעה אינו מקבל 24:00, לכן סיום בחצות מוצג כ-23:59
    end: w.endMinutes >= 24 * 60 ? "23:59" : formatMinutes(w.endMinutes),
    activity: w.activity,
  }));
}

export function fromEditRows(rows: EditRow[]): DayInterval[] {
  return rows.map((r) => {
    const end = parseTimeOption(r.end);
    return {
      startMinutes: parseTimeOption(r.start),
      endMinutes: end >= 23 * 60 + 55 ? 24 * 60 : end,
      activity: r.activity,
    };
  });
}

const MIXED = "MIXED";
const CLOSED = "CLOSED"; // ערך תצוגה בלבד בבורר; ביום סגור נשמר closed=true ולא מסלול

function ActivitySelect({
  value,
  onChange,
  disabled,
  mixed,
  closable,
  closed,
  id,
}: {
  value: ActivityType;
  onChange: (a: ActivityType | typeof CLOSED) => void;
  disabled?: boolean;
  mixed?: boolean;
  /** מוסיף את האפשרות "סגור" (ברמת היום בלבד) */
  closable?: boolean;
  closed?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={closed ? CLOSED : mixed ? MIXED : value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ActivityType | typeof CLOSED)}
      className="field"
    >
      {mixed && (
        <option value={MIXED} disabled>
          מעורב
        </option>
      )}
      {ACTIVITY_TYPES.map((a) => (
        <option key={a} value={a}>
          {ACTIVITY_LABELS[a]}
        </option>
      ))}
      {closable && <option value={CLOSED}>סגור</option>}
    </select>
  );
}

/**
 * עורך יום אחד: מסלול ליום, ובנוסף חלונות מפורשים (התחלה, סיום ומסלול לכל חלון) שגוברים על ברירת המחדל של היום.
 * בחירת מסלול ברמת היום קובעת אותו לכל החלונות ולחלון חדש; אפשר לשנות כל חלון בנפרד.
 */
export function HoursEditor({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: DayEdit;
  onChange: (value: DayEdit) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const { rows } = value;
  const dayActivity = effectiveDayActivity(value);
  const mixed = rows.length > 0 && !rows.every((r) => r.activity === rows[0].activity);

  const setRows = (next: EditRow[]) => onChange({ ...value, dayActivity, rows: next });
  function patch(i: number, change: Partial<EditRow>) {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...change } : r)));
  }
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-day-activity`} className="field-label">
          מסלול פעילות ליום
        </label>
        <ActivitySelect
          id={`${idPrefix}-day-activity`}
          value={dayActivity}
          mixed={mixed}
          closable
          closed={value.closed}
          disabled={disabled}
          onChange={(a) =>
            a === CLOSED
              ? onChange({ ...value, closed: true })
              : onChange({ dayActivity: a, closed: false, rows: rows.map((r) => ({ ...r, activity: a })) })
          }
        />
        <p className="text-xs text-stone-500 mt-1">חל על כל חלונות היום; אפשר לשנות כל חלון בנפרד.</p>
      </div>

      {value.closed ? (
        <p className="text-sm font-semibold text-red-700">היום סגור — לא ניתן להזמין בו תורים. חלונות שהוגדרו נשמרים ויחזרו לפעול כשהיום ייפתח.</p>
      ) : (
        <>
          {rows.length === 0 && (
            <p className="text-sm text-stone-500">
              ללא חלונות מוגדרים — פתוח <span className="tabular-nums" dir="ltr">{formatWindow({ ...DEFAULT_DAY_WINDOW, activity: dayActivity })}</span>{" "}
              במסלול {ACTIVITY_LABELS[dayActivity]}.
            </p>
          )}
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end rounded-xl bg-cream-50 ring-1 ring-cream-200 p-3">
              <label className="block">
                <span className="field-label">התחלה</span>
                <input
                  type="time"
                  step={STEP_MINUTES * 60}
                  value={r.start}
                  disabled={disabled}
                  onChange={(e) => patch(i, { start: e.target.value })}
                  className="field tabular-nums"
                  dir="ltr"
                />
              </label>
              <label className="block">
                <span className="field-label">סיום</span>
                <input
                  type="time"
                  step={STEP_MINUTES * 60}
                  value={r.end}
                  disabled={disabled}
                  onChange={(e) => patch(i, { end: e.target.value })}
                  className="field tabular-nums"
                  dir="ltr"
                />
              </label>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                aria-label="הסרת חלון"
                className="btn btn-ghost px-3! py-2.5!"
              >
                <Icon name="x" className="w-4 h-4" />
              </button>
              <label className="block col-span-3">
                <span className="field-label">מסלול פעילות בחלון</span>
                <ActivitySelect value={r.activity} disabled={disabled} onChange={(a) => patch(i, { activity: a as ActivityType })} />
              </label>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setRows([...rows, { start: "09:00", end: "17:00", activity: dayActivity }])}
            className="btn btn-secondary btn-sm"
          >
            <Icon name="plus" className="w-4 h-4" />
            הוספת חלון
          </button>
        </>
      )}
    </div>
  );
}
