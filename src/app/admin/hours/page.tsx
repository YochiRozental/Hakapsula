"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Icon, Loading, PageHeader } from "@/components/ui";
import { DayHours } from "@/components/hours-summary";
import { fromEditRows, HoursEditor, toEditRows, type EditRow } from "@/components/hours-editor";
import {
  dateKey,
  DEFAULT_WEEKDAY_ACTIVITY,
  isClosedDate,
  OPEN_WEEKDAYS,
  parseDateKey,
  resolveDay,
  weeklyWindows,
  WEEKDAY_LABELS,
  type HoursWindow,
} from "@/lib/opening-hours";

type SaveResult = { windows: HoursWindow[]; outsideAppointments: number; error?: string };
type ExceptionDraft = { date: string; closed: boolean; note: string; rows: EditRow[] };

const jsonHeaders = { "Content-Type": "application/json" };

function weeklyRows(list: HoursWindow[], weekday: number): EditRow[] {
  return toEditRows(weeklyWindows(list, weekday));
}

export default function AdminHoursPage() {
  const [windows, setWindows] = useState<HoursWindow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, EditRow[]>>({});
  const [exception, setException] = useState<ExceptionDraft | null>(null);
  const [newDate, setNewDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  // הטיוטות נבנות מחדש מהשרת אחרי כל טעינה/שמירה — השרת הוא מקור האמת היחיד
  const apply = useCallback((list: HoursWindow[]) => {
    setWindows(list);
    setDrafts(Object.fromEntries(OPEN_WEEKDAYS.map((d) => [d, weeklyRows(list, d)])));
  }, []);

  useEffect(() => {
    fetch("/api/admin/hours")
      .then((res) => res.json())
      .then((list) => apply(Array.isArray(list) ? list : []));
  }, [apply]);

  async function save(url: string, method: string, body: unknown, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: jsonHeaders, body: body ? JSON.stringify(body) : undefined });
      const data = (await res.json()) as SaveResult;
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? "שגיאה בשמירה" });
        return false;
      }
      apply(data.windows);
      setMessage({
        tone: "success",
        text:
          okText +
          (data.outsideAppointments > 0
            ? `. שימו לב: ${data.outsideAppointments} הזמנות עתידיות נמצאות מחוץ לשעות הפעילות הנוכחיות. הן לא בוטלו ונשארות בתוקף.`
            : ""),
      });
      return true;
    } catch {
      setMessage({ tone: "error", text: "שגיאה בלתי צפויה, נסה שוב" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startException(date: string) {
    if (!windows || !date) return;
    if (date < dateKey(new Date())) {
      setMessage({ tone: "error", text: "לא ניתן להגדיר חריג לתאריך שעבר" });
      return;
    }
    if (isClosedDate(date)) {
      setMessage({ tone: "error", text: "יום שבת סגור ולא ניתן לפתוח אותו בחריג" });
      return;
    }
    // נקודת התחלה: מה שחל כרגע בתאריך (ברירת המחדל השבועית או חריג קיים), כדי לערוך רק את ההבדל
    const day = resolveDay(windows, date);
    setMessage(null);
    setException({ date, closed: day.closed, note: day.note ?? "", rows: toEditRows(day.windows) });
  }

  if (windows === null) return <Loading />;

  const today = dateKey(new Date());
  const exceptionDates = [...new Set(windows.filter((w) => w.date && w.date >= today && !isClosedDate(w.date)).map((w) => w.date as string))].sort();

  return (
    <div>
      <PageHeader
        eyebrow="הגדרות"
        title="שעות פעילות"
        subtitle="ברירות מחדל שבועיות לכל החדרים, וחריגים לתאריכים מסוימים. הזמנות קיימות אינן משתנות."
      />

      {message && (
        <div className="mb-6">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      )}

      <section className="mb-10">
        <h2 className="font-display text-xl font-bold text-stone-900 mb-4">ברירת מחדל שבועית</h2>
        <div className="grid xl:grid-cols-2 gap-4">
          {OPEN_WEEKDAYS.map((d) => {
            const label = WEEKDAY_LABELS[d];
            const dirty = JSON.stringify(drafts[d]) !== JSON.stringify(weeklyRows(windows, d));
            return (
              <div key={label} className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-stone-900">יום {label}</h3>
                  <button
                    type="button"
                    disabled={busy || !dirty}
                    onClick={() =>
                      save("/api/admin/hours/weekday", "PUT", { weekday: d, windows: fromEditRows(drafts[d]) }, `יום ${label} נשמר`)
                    }
                    className="btn btn-primary btn-sm"
                  >
                    שמירה
                  </button>
                </div>
                <HoursEditor
                  idPrefix={`weekday-${d}`}
                  defaultActivity={DEFAULT_WEEKDAY_ACTIVITY[d]}
                  rows={drafts[d] ?? []}
                  disabled={busy}
                  onChange={(rows) => setDrafts((prev) => ({ ...prev, [d]: rows }))}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl font-bold text-stone-900 mb-1">חריגים לתאריכים</h2>
        <p className="text-sm text-stone-500 mb-4">חריג דורס את כל שעות היום בתאריך שנבחר, ואינו משנה את שאר השבוע.</p>

        <div className="card p-5 mb-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">תאריך</span>
            <input type="date" value={newDate} min={today} onChange={(e) => setNewDate(e.target.value)} className="field" />
          </label>
          <button type="button" disabled={!newDate || busy} onClick={() => startException(newDate)} className="btn btn-secondary">
            <Icon name="plus" className="w-4 h-4" />
            הגדרת חריג
          </button>
        </div>

        {exception && (
          <div className="card p-5 mb-4 ring-2 ring-brand-600/20">
            <h3 className="font-bold text-stone-900 mb-3">
              חריג ל-
              {new Date(`${exception.date}T00:00:00`).toLocaleDateString("he-IL", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </h3>
            <label className="flex items-center gap-2 mb-3 text-sm font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={exception.closed}
                onChange={(e) => setException({ ...exception, closed: e.target.checked })}
              />
              יום סגור
            </label>
            {!exception.closed && (
              <HoursEditor
                idPrefix="exception"
                defaultActivity={DEFAULT_WEEKDAY_ACTIVITY[parseDateKey(exception.date)?.getDay() ?? 0] ?? "BOYS"}
                rows={exception.rows}
                disabled={busy}
                onChange={(rows) => setException({ ...exception, rows })}
              />
            )}
            <label className="block mt-3">
              <span className="field-label">
                הערה לציבור <span className="font-normal text-stone-400">(לא חובה)</span>
              </span>
              <input
                type="text"
                maxLength={100}
                value={exception.note}
                onChange={(e) => setException({ ...exception, note: e.target.value })}
                className="field"
              />
            </label>
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const ok = await save(
                    "/api/admin/hours/date",
                    "PUT",
                    exception.closed
                      ? { date: exception.date, closed: true, note: exception.note }
                      : { date: exception.date, windows: fromEditRows(exception.rows), note: exception.note },
                    "החריג נשמר"
                  );
                  if (ok) setException(null);
                }}
                className="btn btn-primary"
              >
                שמירת חריג
              </button>
              <button type="button" disabled={busy} onClick={() => setException(null)} className="btn btn-secondary">
                ביטול
              </button>
            </div>
          </div>
        )}

        {exceptionDates.length === 0 ? (
          <p className="text-sm text-stone-400">אין חריגים עתידיים</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {exceptionDates.map((d) => (
              <div key={d} className="card p-5">
                <h3 className="font-bold text-stone-900 mb-3">
                  {new Date(`${d}T00:00:00`).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}
                </h3>
                <DayHours day={resolveDay(windows, d)} />
                <div className="flex gap-2 mt-4">
                  <button type="button" disabled={busy} onClick={() => startException(d)} className="btn btn-secondary btn-sm">
                    עריכה
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save(`/api/admin/hours/date?date=${d}`, "DELETE", undefined, "החריג בוטל, חזרה לברירת המחדל")}
                    className="btn btn-ghost btn-sm"
                  >
                    ביטול חריג
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
