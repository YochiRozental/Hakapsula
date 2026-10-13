"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";

const WEEKDAY_LABELS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
const MONTH_LABELS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

function toIsoDate(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseIsoDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

type MonthCalendarProps = {
  value: string;
  onChange: (date: string) => void;
  minDate?: string;
  markedDates?: Set<string>;
  onMonthChange?: (year: number, month: number) => void;
};

export function MonthCalendar({ value, onChange, minDate, markedDates, onMonthChange }: MonthCalendarProps) {
  const selected = parseIsoDate(value);
  const [viewYear, setViewYear] = useState(selected.year);
  const [viewMonth, setViewMonth] = useState(selected.month);

  // keep the displayed month in sync when `value` changes from outside (e.g. a restored selection)
  useEffect(() => {
    setViewYear(selected.year);
    setViewMonth(selected.month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const todayIso = toIsoDate(
    new Date().getFullYear(),
    new Date().getMonth(),
    new Date().getDate()
  );

  function changeMonth(delta: number) {
    let year = viewYear;
    let month = viewMonth + delta;
    if (month < 0) {
      month = 11;
      year -= 1;
    } else if (month > 11) {
      month = 0;
      year += 1;
    }
    setViewYear(year);
    setViewMonth(month);
    onMonthChange?.(year, month);
  }

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();

  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => changeMonth(-1)}
          className="w-9 h-9 rounded-full bg-white ring-1 ring-cream-300 shadow-sm text-stone-500 hover:ring-bronze-300 hover:text-brand-700 flex items-center justify-center transition-colors"
          aria-label="חודש קודם"
        >
          <Icon name="chevronRight" className="w-4 h-4" />
        </button>
        <p className="font-display font-bold text-stone-900 text-base">
          {MONTH_LABELS[viewMonth]} {viewYear}
        </p>
        <button
          type="button"
          onClick={() => changeMonth(1)}
          className="w-9 h-9 rounded-full bg-white ring-1 ring-cream-300 shadow-sm text-stone-500 hover:ring-bronze-300 hover:text-brand-700 flex items-center justify-center transition-colors"
          aria-label="חודש הבא"
        >
          <Icon name="chevronLeft" className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-bronze-500 mb-2 pb-2 border-b border-cream-200">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const iso = toIsoDate(viewYear, viewMonth, day);
          const isSelected = iso === value;
          const isToday = iso === todayIso;
          const isDisabled = !!minDate && iso < minDate;
          const isMarked = markedDates?.has(iso);

          return (
            <button
              type="button"
              key={i}
              disabled={isDisabled}
              onClick={() => onChange(iso)}
              className={`relative mx-auto w-9 h-9 sm:w-10 sm:h-10 rounded-full text-sm tabular-nums transition-all duration-150 ${
                isSelected
                  ? "bg-linear-to-b from-brand-500 to-brand-700 text-white font-bold shadow-brand ring-4 ring-brand-600/10"
                  : isDisabled
                    ? "text-stone-300 cursor-not-allowed"
                    : isToday
                      ? "ring-1 ring-bronze-300 text-bronze-700 font-bold hover:bg-bronze-50"
                      : "text-stone-700 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-cream-300"
              }`}
            >
              {day}
              {isMarked && !isSelected && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-gold-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
