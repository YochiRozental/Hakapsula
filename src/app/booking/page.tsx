"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import {
  activityMatches,
  explainUnavailable,
  formatMinutes,
  formatWindow,
  parseTimeOption,
} from "@/lib/opening-hours";
import {
  combineDateAndTime,
  todayIsoDate,
  WEB_BOOKING_DURATION_MINUTES,
} from "@/lib/slots";
import { MonthCalendar } from "@/components/month-calendar";
import { ClockTimePicker } from "@/components/clock-time-picker";
import { useDayHours } from "@/lib/use-day-hours";
import { probeGate, usePaymentsGate } from "@/lib/payments/client";
import {
  Alert,
  BrandHeader,
  Icon,
  ROOM_ACCENTS,
  RoomTile,
  RoomVisual,
  SectionTitle,
} from "@/components/ui";
import type { RoomKey } from "@/generated/prisma/client";

type BusyInterval = {
  startTime: string;
  endTime: string;
  room: { key: RoomKey; name: string };
};

const durationMinutes = WEB_BOOKING_DURATION_MINUTES;
// בשעון מוצגות שעות עגולות בלבד (בלי דקות); אלו שאינן זמינות לפי שעות הפעילות של המסלול מוצגות מוחלשות
const CLOCK_STEP_MINUTES = 60;
const MIN_START_MINUTES = 0;
const MAX_START_MINUTES = 24 * 60 - durationMinutes;
const DEFAULT_START_TIME = formatMinutes(8 * 60);
function isValidStart(t: string) {
  const total = parseTimeOption(t);
  return (
    /^\d{2}:\d{2}$/.test(t) &&
    total >= MIN_START_MINUTES &&
    total <= MAX_START_MINUTES &&
    total % CLOCK_STEP_MINUTES === 0
  );
}
const LAST_SELECTION_KEY = "booking:lastSelection";

type StoredSelection = {
  date: string;
  roomKey: RoomKey;
  startTime: string;
  notes?: string;
};

export default function BookingPage() {
  const router = useRouter();
  // שער זרימת התשלום: סגור כברירת מחדל (באתר החי תמיד סגור); כשסגור ההזמנה פועלת בדיוק כמו קודם
  const paymentsGate = usePaymentsGate();
  // משמרות קבועות: הקישור מופיע רק כשהשער פתוח (באתר החי הנתיב מחזיר 404) ורק ללקוח מחובר
  const [shiftsOpen, setShiftsOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/shifts")
      .then((res) => {
        if (!cancelled) setShiftsOpen(res.status === 200);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const [roomKey, setRoomKey] = useState<RoomKey>("ROOM1");
  const [date, setDate] = useState(todayIsoDate());
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME);
  const [notes, setNotes] = useState("");
  // ערכים גולמיים של הזנה ידנית; null = מציגים את הבחירה הנוכחית (מהלוח / מהרשת)
  const [dateDraft, setDateDraft] = useState<string | null>(null);

  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [loadingBusy, setLoadingBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // חסר פרט פרופיל שחוסם הזמנה (כולל מגדר, שאינו מוזכר כאן בשם — ראו "אין להחזיר כיתובים על בנים/בנות")
  const [profileIncomplete, setProfileIncomplete] = useState(false);

  // restore the last date/room/time the user had selected, instead of always resetting to today
  useEffect(() => {
    const raw = window.localStorage.getItem(LAST_SELECTION_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as Partial<StoredSelection>;
      /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from localStorage after mount; reading storage during render would break SSR hydration */
      if (stored.date && stored.date >= todayIsoDate()) setDate(stored.date);
      if (stored.roomKey && ROOM_KEYS.includes(stored.roomKey))
        setRoomKey(stored.roomKey);
      if (stored.startTime && isValidStart(stored.startTime))
        setStartTime(stored.startTime);
      if (stored.notes) setNotes(stored.notes);
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {
      // ignore corrupt storage
    }
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
    const selection: StoredSelection = { date, roomKey, startTime, notes };
    window.localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(selection));
  }, [date, roomKey, startTime, notes]);

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

  // שעות הפעילות ליום הנבחר — אותו מקור נתונים שבו משתמש השרת לאימות
  const { day: dayHours, userTrack } = useDayHours(date);

  const track = userTrack; // מסלול המשתמש המחובר (לפי המגדר שלו); בלעדיו מוצגים כל החלונות
  const isToday = date === todayIsoDate();
  const unavailableReason = (startMinutes: number): string | null => {
    if (!dayHours) return "טוען שעות פעילות...";
    if (isToday) {
      const now = new Date();
      if (startMinutes < now.getHours() * 60 + now.getMinutes())
        return "השעה כבר עברה";
    }
    const reason = explainUnavailable(
      dayHours,
      startMinutes,
      startMinutes + durationMinutes,
      track ?? undefined,
    );
    return reason ? "המועד אינו זמין להזמנה" : null;
  };
  const selectedReason = unavailableReason(parseTimeOption(startTime));
  const dayWindows = dayHours?.windows ?? [];
  // רק המועדים הפנויים עבור המשתמש (לפי המסלול שלו) — בלי לחשוף את החלוקה הפנימית
  const availableWindows = dayWindows.filter((w) =>
    activityMatches(w.activity, track ?? undefined),
  );

  const endTimeLabel = formatMinutes(
    parseTimeOption(startTime) + durationMinutes,
  );
  const conflict = useMemo(() => {
    const start = combineDateAndTime(date, startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return busy.some(
      (b) => start < new Date(b.endTime) && end > new Date(b.startTime),
    );
  }, [busy, date, startTime]);

  const dateDraftInvalid =
    dateDraft !== null && (!dateDraft || dateDraft < todayIsoDate());

  function handleManualDate(value: string) {
    setDateDraft(value);
    if (value && value >= todayIsoDate()) setDate(value);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProfileIncomplete(false);
    setSubmitting(true);

    const start = combineDateAndTime(date, startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    try {
      // כשהשער פתוח (סביבת פיתוח): יוצרים החזקה ל-10 דקות ועוברים לתשלום. ההזמנה מאושרת רק אחרי אימות בשרת
      const paymentsOn = paymentsGate.loaded
        ? paymentsGate.enabled
        : await probeGate();
      const res = await fetch(
        paymentsOn ? "/api/payments/holds" : "/api/appointments",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomKey,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            notes,
          }),
        },
      );
      const data = await res.json();

      // הבחירה כבר נשמרת ב-localStorage, ולכן היא תשוחזר בחזרה לעמוד זה
      if (res.status === 401) {
        router.push(`/login?callbackUrl=${encodeURIComponent("/booking")}`);
        return;
      }
      if (data.code === "PROFILE_INCOMPLETE") {
        // מגדר הוא ההגדרה היחידה שקובעת את שעות ההזמנה הפנויות; במקרה הזה מציגים הודעה ידידותית
        // עם קישור ישיר לפרופיל, בלי להסביר למה, ולא עוברים אוטומטית לטופס השלמת הפרטים
        if (Array.isArray(data.missing) && data.missing.includes("gender")) {
          setProfileIncomplete(true);
          setSubmitting(false);
          return;
        }
        router.push(`/complete-profile?next=${encodeURIComponent("/booking")}`);
        return;
      }
      if (data.code === "NOT_APPROVED") {
        router.push("/account-status");
        return;
      }

      if (!res.ok) {
        setError(data.error ?? "שגיאה בהזמנת הקליניקה");
        setSubmitting(false);
        return;
      }

      if (paymentsOn) {
        router.push(`/booking/checkout/${data.appointmentId}`);
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
        title="הזמנת קליניקה"
        subtitle="בחרו חדר, תאריך ושעה — ואנחנו נדאג לשאר"
      >
        <ol className="hidden md:flex items-center gap-2 text-xs text-white/70">
          {["חדר", "תאריך", "שעה"].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full border border-bronze-300/50 text-bronze-200 flex items-center justify-center tabular-nums">
                {i + 1}
              </span>
              {step}
              {i < 2 && <span className="w-5 h-px bg-white/25" />}
            </li>
          ))}
        </ol>
      </BrandHeader>

      {shiftsOpen && (
        <Link
          href="/profile/shifts"
          className="card card-hover flex items-center gap-4 p-4 mb-6"
          data-testid="shifts-banner"
        >
          <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
            <Icon name="calendar" className="w-5 h-5" />
          </span>
          <span className="flex-1">
            <span className="block font-display font-bold text-stone-900">
              משמרת קבועה במחיר חודשי
            </span>
            <span className="block text-sm text-stone-500">
              אותו חדר, אותו יום ואותן שעות בכל שבוע, לפחות 3 חודשים. למחירון
              ולהזמנה
            </span>
          </span>
          <Icon name="chevronLeft" className="w-5 h-5 text-stone-400" />
        </Link>
      )}

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
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${ROOM_ACCENTS[key].dot}`}
                    />
                  </span>
                  <span
                    className={`absolute inset-x-0 bottom-0 h-0.5 transition-opacity ${
                      active
                        ? "bg-linear-to-l from-brand-500 via-bronze-400 to-brand-500 opacity-100"
                        : "opacity-0"
                    }`}
                  />
                </button>
              );
            })}
          </div>
          {roomKey === "ROOM1_2" && (
            <p className="flex items-start gap-2 text-xs text-bronze-700 bg-bronze-50 ring-1 ring-bronze-100 rounded-xl px-3.5 py-2.5 mt-4">
              <Icon name="sparkle" className="w-4 h-4 shrink-0" />
              שים לב: הזמנת חדר 1+2 חוסמת גם את חדר 1 וגם את חדר 2 בטווח הזמן
              שנבחר.
            </p>
          )}
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          <section className="card p-5 sm:p-8">
            <SectionTitle index="02" hint="ימים שעברו אינם זמינים">
              תאריך
            </SectionTitle>
            <div className="mb-4">
              <label htmlFor="booking-date" className="field-label">
                הזנה ידנית של תאריך
              </label>
              <input
                id="booking-date"
                type="date"
                value={dateDraft ?? date}
                min={todayIsoDate()}
                onChange={(e) => handleManualDate(e.target.value)}
                onBlur={() => setDateDraft(null)}
                className="field"
              />
              {dateDraftInvalid && (
                <p className="text-xs text-red-600 mt-1.5">
                  הזינו תאריך תקין מהיום ואילך
                </p>
              )}
            </div>
            <div className="rounded-2xl bg-cream-50 ring-1 ring-cream-200 p-4 sm:p-5">
              <MonthCalendar
                value={date}
                onChange={(d) => {
                  setDateDraft(null);
                  setDate(d);
                }}
                minDate={todayIsoDate()}
              />
            </div>
          </section>

          <div className="space-y-6">
            <section className="card p-5 sm:p-8">
              <SectionTitle
                index="03"
                hint="ההזמנה היא לשעה אחת · התנגשות עם הזמנה קיימת תוצג בסיכום למטה"
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
              <div
                className="mb-5 text-sm rounded-xl bg-cream-50 ring-1 ring-cream-200 px-3.5 py-3 space-y-2"
                aria-live="polite"
              >
                <p className="font-semibold text-stone-600">
                  שעות פעילות ביום זה:
                </p>
                {!dayHours ? (
                  <p className="text-stone-500">טוען...</p>
                ) : availableWindows.length === 0 ? (
                  <p className="text-red-600">אין מועדים פנויים ביום זה</p>
                ) : (
                  <ul className="space-y-1.5">
                    {availableWindows.map((w, i) => (
                      <li
                        key={i}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 text-stone-800"
                      >
                        <span className="tabular-nums font-semibold" dir="ltr">
                          {formatWindow(w)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-stone-500">
                  {userTrack === null
                    ? "התחברו כדי להזמין — יוצגו לך השעות הפנויות עבורך."
                    : "שעות שעברו אינן זמינות לבחירה."}
                </p>
              </div>
              <ClockTimePicker
                id="booking-time"
                inline
                label="בחירת שעת התחלה"
                value={startTime}
                onChange={setStartTime}
                minMinutes={MIN_START_MINUTES}
                maxMinutes={MAX_START_MINUTES}
                stepMinutes={CLOCK_STEP_MINUTES}
                hoursOnly
                unavailable={(m) => unavailableReason(m) !== null}
              />
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

        {profileIncomplete && (
          <Alert tone="error">
            כדי להזמין קליניקה, יש להשלים את הפרטים בפרופיל האישי.{" "}
            <Link href="/profile" className="underline font-semibold">
              לפרופיל האישי
            </Link>
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {success && (
          <Alert tone="success">
            ההזמנה נקבעה בהצלחה! מעביר אותך להזמנות שלי...
          </Alert>
        )}

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
                <p className="text-sm text-red-200 font-semibold">
                  השעה מתנגשת עם הזמנה קיימת
                </p>
              )}
              {!conflict && dayHours && selectedReason && (
                <p className="text-sm text-red-200 font-semibold">
                  לא ניתן להזמין קליניקה – {selectedReason}
                </p>
              )}
            </div>
          </div>
          <button
            type="submit"
            disabled={
              submitting ||
              conflict ||
              dateDraftInvalid ||
              selectedReason !== null
            }
            className="btn btn-bronze px-8! py-3! text-base!"
          >
            {submitting
              ? paymentsGate.enabled
                ? "שומר את החדר..."
                : "קובע קליניקה..."
              : paymentsGate.enabled
                ? "המשך לתשלום"
                : "הזמנת קליניקה"}
            {!submitting && <Icon name="arrowLeft" className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
