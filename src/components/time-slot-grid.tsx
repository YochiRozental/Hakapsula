"use client";

import { combineDateAndTime } from "@/lib/slots";

type BusyInterval = { startTime: string; endTime: string };

type TimeSlotGridProps = {
  date: string;
  timeOptions: string[];
  selected: string;
  onSelect: (time: string) => void;
  busy: BusyInterval[];
};

export function TimeSlotGrid({ date, timeOptions, selected, onSelect, busy }: TimeSlotGridProps) {
  // eslint-disable-next-line react-hooks/purity -- used only to grey out past time slots, staleness is harmless
  const now = Date.now();

  function isOverlapping(time: string) {
    const start = combineDateAndTime(date, time);
    return busy.some((b) => {
      const bStart = new Date(b.startTime);
      const bEnd = new Date(b.endTime);
      return start >= bStart && start < bEnd;
    });
  }

  return (
    <div className="grid grid-cols-3 min-[400px]:grid-cols-4 sm:grid-cols-5 md:grid-cols-4 lg:grid-cols-5 gap-2 max-h-80 overflow-y-auto p-3">
      {timeOptions.map((time) => {
        const start = combineDateAndTime(date, time);
        const isPast = start.getTime() < now;
        const isBusy = !isPast && isOverlapping(time);
        const isSelected = time === selected;
        const isDisabled = isPast || isBusy;

        return (
          <button
            type="button"
            key={time}
            disabled={isDisabled}
            onClick={() => onSelect(time)}
            title={isBusy ? "תפוס" : isPast ? "עבר" : undefined}
            className={`h-11 rounded-xl text-sm font-semibold tabular-nums transition-all duration-150 ${
              isSelected
                ? "bg-linear-to-b from-brand-500 to-brand-700 text-white shadow-brand ring-2 ring-brand-600/15"
                : isDisabled
                  ? "bg-transparent text-stone-300 line-through cursor-not-allowed"
                  : "bg-white ring-1 ring-cream-300 text-stone-700 shadow-sm hover:ring-bronze-300 hover:text-brand-700 hover:-translate-y-px"
            }`}
          >
            {time}
          </button>
        );
      })}
    </div>
  );
}
