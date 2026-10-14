"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_LABELS } from "@/lib/rooms";
import { buildTimeOptions, combineDateAndTime, todayIsoDate, DURATION_OPTIONS } from "@/lib/slots";
import { MonthCalendar } from "@/components/month-calendar";
import { TimeSlotGrid } from "@/components/time-slot-grid";
import { Alert, BrandHeader, Icon, ROOM_ACCENTS, RoomTile, RoomVisual, SectionTitle } from "@/components/ui";
import type { RoomKey } from "@/generated/prisma/client";

type BusyInterval = { startTime: string; endTime: string; room: { key: RoomKey; name: string } };

const ROOM_KEYS: RoomKey[] = ["ROOM1", "ROOM2", "ROOM3", "ROOM4", "WORKSHOP", "ROOM1_2"];
const TIME_OPTIONS = buildTimeOptions();
const LAST_SELECTION_KEY = "booking:lastSelection";

type StoredSelection = {
  date: string;
  roomKey: RoomKey;
  startTime: string;
  durationMinutes: number;
};

export default function BookingPage() {
  const router = useRouter();
  const [roomKey, setRoomKey] = useState<RoomKey>("ROOM1");
  const [date, setDate] = useState(todayIsoDate());
  const [startTime, setStartTime] = useState(TIME_OPTIONS[0]);
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [loadingBusy, setLoadingBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // restore the last date/room/time the user had selected, instead of always resetting to today
  useEffect(() => {
    const raw = window.localStorage.getItem(LAST_SELECTION_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as Partial<StoredSelection>;
      if (stored.date && stored.date >= todayIsoDate()) setDate(stored.date);
      if (stored.roomKey && ROOM_KEYS.includes(stored.roomKey)) setRoomKey(stored.roomKey);
      if (stored.startTime && TIME_OPTIONS.includes(stored.startTime)) setStartTime(stored.startTime);
      if (stored.durationMinutes) setDurationMinutes(stored.durationMinutes);
    } catch {
      // ignore corrupt storage
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // skip the very first commit: at that point state still holds the pre-restore defaults
  // (the restore effect's setState calls above haven't flushed into this closure yet), so
  // persisting here would immediately overwrite the stored selection with those defaults.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    const selection: StoredSelection = { date, roomKey, startTime, durationMinutes };
    window.localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(selection));
  }, [date, roomKey, startTime, durationMinutes]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for a client-side fetch triggered by date/room changes
    setLoadingBusy(true);
    setError(null);
    fetch(`/api/appointments/day?date=${date}&roomKey=${roomKey}`)
      .then((res) => res.json())
      .then((data) => setBusy(Array.isArray(data) ? data : []))
      .catch(() => setBusy([]))
      .finally(() => setLoadingBusy(false));
  }, [date, roomKey]);

  const { conflict, endTimeLabel } = useMemo(() => {
    const start = combineDateAndTime(date, startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const hasConflict = busy.some((b) => {
      const bStart = new Date(b.startTime);
      const bEnd = new Date(b.endTime);
      return start < bEnd && end > bStart;
    });
    return {
      conflict: hasConflict,
      endTimeLabel: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
    };
  }, [busy, date, startTime, durationMinutes]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const start = combineDateAndTime(date, startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomKey,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          notes,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה בקביעת התור");
        setSubmitting(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => router.push("/booking/my"), 1200);
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <BrandHeader
        eyebrow="הזמנת חדר"
        title="קביעת תור"
        subtitle="בחרו חדר, תאריך ושעה — ואנחנו נדאג לשאר"
      >
        <ol className="hidden md:flex items-center gap-2 text-xs text-white/70">
          {["חדר", "תאריך", "משך", "שעה"].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full border border-bronze-300/50 text-bronze-200 flex items-center justify-center tabular-nums">
                {i + 1}
              </span>
              {step}
              {i < 3 && <span className="w-5 h-px bg-white/25" />}
            </li>
          ))}
        </ol>
      </BrandHeader>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="card p-5 sm:p-8">
          <SectionTitle index="01" hint="בחרו את החלל המתאים לפגישה">
            בחירת חדר
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {ROOM_KEYS.map((key) => {
              const active = roomKey === key;
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setRoomKey(key)}
                  aria-pressed={active}
                  className={`group relative overflow-hidden rounded-[1.25rem] border bg-white text-right transition-all duration-200 cursor-pointer ${
                    active
                      ? "border-brand-600 ring-4 ring-brand-600/10 shadow-lift -translate-y-0.5"
                      : "border-cream-200 shadow-soft hover:-translate-y-0.5 hover:border-bronze-300 hover:shadow-lift"
                  }`}
                >
                  <RoomVisual roomKey={key} className="h-24 sm:h-28" />
                  <span
                    className={`absolute top-3 left-3 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                      active
                        ? "bg-brand-600 text-white shadow-brand scale-100"
                        : "bg-white/80 ring-1 ring-cream-300 text-transparent scale-90"
                    }`}
                  >
                    <Icon name="check" className="w-3.5 h-3.5" />
                  </span>
                  <span className="flex items-center justify-between gap-2 px-4 py-3.5">
                    <span
                      className={`font-display text-base font-bold ${active ? "text-brand-800" : "text-stone-800"}`}
                    >
                      {ROOM_LABELS[key]}
                    </span>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${ROOM_ACCENTS[key].dot}`} />
                  </span>
                  <span
                    className={`absolute inset-x-0 bottom-0 h-0.5 transition-opacity ${
                      active ? "bg-linear-to-l from-brand-500 via-bronze-400 to-brand-500 opacity-100" : "opacity-0"
                    }`}
                  />
                </button>
              );
            })}
          </div>
          {roomKey === "ROOM1_2" && (
            <p className="flex items-start gap-2 text-xs text-bronze-700 bg-bronze-50 ring-1 ring-bronze-100 rounded-xl px-3.5 py-2.5 mt-4">
              <Icon name="sparkle" className="w-4 h-4 shrink-0" />
              שים לב: הזמנת חדר 1+2 חוסמת גם את חדר 1 וגם את חדר 2 בטווח הזמן שנבחר.
            </p>
          )}
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          <section className="card p-5 sm:p-8">
            <SectionTitle index="02" hint="ימים שעברו אינם זמינים">
              תאריך
            </SectionTitle>
            <div className="rounded-2xl bg-cream-50 ring-1 ring-cream-200 p-4 sm:p-5">
              <MonthCalendar value={date} onChange={setDate} minDate={todayIsoDate()} />
            </div>
          </section>

          <div className="space-y-6">
            <section className="card p-5 sm:p-8">
              <SectionTitle index="03" hint="כמה זמן תצטרכו את החדר?">
                משך התור
              </SectionTitle>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((opt) => {
                  const active = durationMinutes === opt.minutes;
                  return (
                    <button
                      type="button"
                      key={opt.minutes}
                      onClick={() => setDurationMinutes(opt.minutes)}
                      aria-pressed={active}
                      className={`btn ${active ? "btn-primary" : "btn-secondary"}`}
                    >
                      <Icon name="clock" className={`w-4 h-4 ${active ? "opacity-90" : "text-bronze-500"}`} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="card p-5 sm:p-8">
              <SectionTitle
                index="04"
                hint="שעות תפוסות מסומנות בקו חוצה"
                aside={
                  loadingBusy && (
                    <span className="flex items-center gap-1.5 text-xs text-stone-400">
                      <span className="w-3 h-3 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin" />
                      בודק זמינות...
                    </span>
                  )
                }
              >
                שעת התחלה
              </SectionTitle>
              <div className="rounded-2xl bg-cream-50 ring-1 ring-cream-200">
                <TimeSlotGrid
                  date={date}
                  timeOptions={TIME_OPTIONS}
                  selected={startTime}
                  onSelect={setStartTime}
                  busy={busy}
                />
              </div>
            </section>
          </div>
        </div>

        <section className="card p-5 sm:p-8">
          <label htmlFor="booking-notes" className="field-label">
            הערות <span className="font-normal text-stone-400">(לא חובה)</span>
          </label>
          <textarea
            id="booking-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="field"
          />
        </section>

        {error && <Alert tone="error">{error}</Alert>}
        {success && <Alert tone="success">התור נקבע בהצלחה! מעביר אותך לתורים שלי...</Alert>}

        <div className="sticky bottom-3 z-10 panel-brand rounded-[1.5rem] p-4 sm:px-7 sm:py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <RoomTile roomKey={roomKey} className="hidden sm:flex w-12 h-12" />
            <div className="min-w-0">
              <p className="text-xs text-bronze-200 tracking-wide truncate">
                {ROOM_LABELS[roomKey]} ·{" "}
                {new Date(`${date}T00:00:00`).toLocaleDateString("he-IL", {
                  weekday: "long",
                  day: "numeric",
                  month: "numeric",
                })}
              </p>
              <p className="font-display text-2xl font-bold tabular-nums">
                {startTime} – {endTimeLabel}
              </p>
              {conflict && (
                <p className="text-sm text-red-200 font-semibold">השעה מתנגשת עם תור קיים</p>
              )}
            </div>
          </div>
          <button type="submit" disabled={submitting || conflict} className="btn btn-bronze px-8! py-3! text-base!">
            {submitting ? "קובע תור..." : "קביעת תור"}
            {!submitting && <Icon name="arrowLeft" className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
