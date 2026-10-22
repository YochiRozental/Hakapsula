"use client";

import { useState } from "react";
import {
  ACTIVITY_LABELS,
  ACTIVITY_TYPES,
  formatMinutes,
  parseTimeOption,
  STEP_MINUTES,
  type ActivityType,
  type DayInterval,
} from "@/lib/opening-hours";
import { Icon } from "@/components/ui";

export type EditRow = { start: string; end: string; activity: ActivityType };

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

function ActivitySelect({
  value,
  onChange,
  disabled,
  mixed,
  id,
}: {
  value: ActivityType;
  onChange: (a: ActivityType) => void;
  disabled?: boolean;
  mixed?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={mixed ? MIXED : value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ActivityType)}
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
    </select>
  );
}

/**
 * עורך רשימת חלונות של יום אחד: התחלה, סיום וסוג פעילות לכל חלון.
 * בחירת סוג ברמת היום קובעת את הסוג לכל החלונות (וכברירת מחדל לחלונות חדשים); אפשר לשנות כל חלון בנפרד.
 */
export function HoursEditor({
  rows,
  onChange,
  disabled,
  idPrefix,
  defaultActivity,
}: {
  rows: EditRow[];
  onChange: (rows: EditRow[]) => void;
  disabled?: boolean;
  idPrefix: string;
  /** מסלול ברירת המחדל של היום (לחלון חדש כשאין עדיין חלונות) */
  defaultActivity: ActivityType;
}) {
  const [dayDefault, setDayDefault] = useState<ActivityType>(defaultActivity);
  const uniform = rows.length > 0 && rows.every((r) => r.activity === rows[0].activity);
  const mixed = rows.length > 0 && !uniform;
  // ברירת המחדל לחלון חדש: סוג היום כשאחיד, אחרת מה שנבחר לאחרונה
  const dayActivity = uniform ? rows[0].activity : dayDefault;

  function patch(i: number, change: Partial<EditRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...change } : r)));
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
          disabled={disabled}
          onChange={(a) => {
            setDayDefault(a);
            onChange(rows.map((r) => ({ ...r, activity: a })));
          }}
        />
        <p className="text-xs text-stone-500 mt-1">חל על כל חלונות היום; אפשר לשנות כל חלון בנפרד.</p>
      </div>

      {rows.length === 0 && <p className="text-sm text-stone-400">אין פעילות ביום זה</p>}
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
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            aria-label="הסרת חלון"
            className="btn btn-ghost px-3! py-2.5!"
          >
            <Icon name="x" className="w-4 h-4" />
          </button>
          <label className="block col-span-3">
            <span className="field-label">מסלול פעילות בחלון</span>
            <ActivitySelect value={r.activity} disabled={disabled} onChange={(a) => patch(i, { activity: a })} />
          </label>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...rows, { start: "09:00", end: "17:00", activity: dayActivity }])}
        className="btn btn-secondary btn-sm"
      >
        <Icon name="plus" className="w-4 h-4" />
        הוספת חלון
      </button>
    </div>
  );
}
