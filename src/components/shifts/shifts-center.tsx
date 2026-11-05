"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, EmptyState, Icon, Loading, SectionTitle } from "@/components/ui";
import { Dialog, ToneBadge, jerusalemTime } from "@/components/shifts/bits";
import { api, shekel, useSingleFlight } from "@/lib/payments/client";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { todayIsoDate } from "@/lib/slots";
import { weekdayOf } from "@/lib/shifts/calendar";
import { ShiftPriceTable } from "@/components/shifts/price-table";
import { windowLabelOf, type ShiftWindowDef } from "@/lib/shifts/windows";
import {
  CHARGE_STATUS_TEXT,
  OCCURRENCE_STATUS_TEXT,
  REQUEST_KIND_TEXT,
  REQUEST_STATUS_TEXT,
  SHIFT_STATUS_TEXT,
  WEEKDAY_NAMES,
  dateLabel,
  failureText,
  minutesLabel,
  MAKEUP_STATE_TEXT,
  monthLabel,
  suspensionText,
  windowLabel,
} from "@/lib/shifts/labels";
import type { MyShiftsView, ShiftView } from "@/lib/shifts/views";

interface PreviewOccurrence {
  date: string;
  month: string;
  startTime: string;
  endTime: string;
  priceAgorot: number;
  skipReason: string | null;
}
interface Preview {
  startDate: string;
  endDate: string;
  monthlyPriceAgorot: number;
  totalAgorot: number;
  firstChargeAgorot: number;
  months: { month: string; dueDate: string; count: number; amountAgorot: number; isFirst: boolean }[];
  conflicts: { date: string; reason: string }[];
  occurrences: PreviewOccurrence[];
}

const newKey = () => globalThis.crypto.randomUUID().replace(/-/g, "");

export function ShiftsCenter({ mockCardLink, windows }: { mockCardLink: boolean; windows: ShiftWindowDef[] }) {
  const [data, setData] = useState<MyShiftsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<MyShiftsView>("/api/shifts");
    if (res.ok) setData(res.data as MyShiftsView);
    else setError(res.data.error ?? "שגיאה בטעינת המשמרות");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת המשמרות מהשרת בעת פתיחת העמוד
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <Loading />;

  return (
    <div className="space-y-8">
      {notice && <Alert tone="success">{notice}</Alert>}

      <section className="space-y-4">
        <SectionTitle hint="שינוי או ביטול של משמרת מחייבים אישור מנהל">המשמרות שלי</SectionTitle>
        {data.shifts.length === 0 ? (
          <EmptyState icon="calendar">אין לכם משמרות קבועות.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {data.shifts.map((s) => (
              <ShiftCard key={s.id} shift={s} windows={windows} onChanged={load} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </section>

      <ShiftPriceTable windows={windows} />

      <section className="space-y-4">
        <SectionTitle hint="משמרת קבועה: אותו חדר, אותו יום ואותה משבצת, לשלושה חודשים קלנדריים לפחות">הזמנת משמרת חדשה</SectionTitle>
        {!data.eligible ? (
          <p className="card p-5 text-sm text-stone-600" data-testid="not-eligible">
            הזמנת משמרות קבועות זמינה ללקוחות שאושרו לכך על ידי ההנהלה. לבקשת אישור אפשר לפנות אלינו.
          </p>
        ) : (
          <NewShift
            windows={windows}
            hasCard={data.hasUsableCard}
            mockCardLink={mockCardLink}
            onCreated={(message) => {
              setNotice(message);
              void load();
            }}
          />
        )}
      </section>
    </div>
  );
}

// ───────────────────────────── כרטיס משמרת ─────────────────────────────

function ShiftCard({ shift, windows, onChanged, onNotice }: { shift: ShiftView; windows: ShiftWindowDef[]; onChanged: () => void; onNotice: (m: string) => void }) {
  const [dialog, setDialog] = useState<"CHANGE" | "CANCEL" | null>(null);
  const st = SHIFT_STATUS_TEXT[shift.status] ?? { label: shift.status, tone: "neutral" as const };
  const canRequest = (shift.status === "ACTIVE" || shift.status === "SUSPENDED") && !shift.openRequest;
  const latest = shift.requests[0];

  return (
    <li className="card p-5 sm:p-6 space-y-4" data-testid="shift-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-stone-900">
            {shift.room.name} · יום {WEEKDAY_NAMES[shift.weekday]} · {windowLabel(shift.windowId)}
          </p>
          <p className="text-sm text-stone-500 mt-1">
            {dateLabel(shift.startDate)} עד {dateLabel(shift.endDate)} ·{" "}
            {shift.monthlyPriceAgorot > 0
              ? `${shekel(shift.monthlyPriceAgorot)} לחודש, ${shekel(shift.totalAgorot)} לשלושה חודשים (כולל מע"מ)`
              : `${shekel(shift.occurrencePriceAgorot)} למופע`}
          </p>
          {shift.paymentMode === "MANUAL" && <p className="text-xs text-stone-500 mt-1">תשלום ידני בתיאום עם ההנהלה: אין חיוב אוטומטי, ההנהלה מתעדת כל תשלום שהתקבל.</p>}
        </div>
        <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      </div>

      {shift.status === "SUSPENDED" && (
        <Alert tone="error">
          המשמרת מושעית: {suspensionText(shift.suspensionReason)}. המשבצות שלכם נשמרות, אך אין אפשרות להשתמש במשמרת עד החלטת מנהל.
        </Alert>
      )}
      {shift.status === "PENDING" && <p className="text-sm text-bronze-700">החיוב הראשון בבירור. המשבצות שמורות עד לאישור.</p>}
      {shift.makeups.length > 0 && (
        <div className="rounded-xl bg-cream-50 ring-1 ring-cream-200 px-4 py-3 text-sm space-y-2" data-testid="makeups">
          <p className="font-semibold text-stone-800">
            שעות חלופיות (הקליניקה נסגרה ביוזמת ההנהלה)
            {shift.makeupMinutesRemaining > 0 && <> · יתרה: <strong>{minutesLabel(shift.makeupMinutesRemaining)}</strong></>}
          </p>
          <ul className="space-y-1 text-stone-600">
            {shift.makeups.map((m) => (
              <li key={m.occurrenceId}>
                {dateLabel(m.date)}: מגיעות {minutesLabel(m.minutesTotal)}
                {m.state === "OPEN" && m.minutesRemaining < m.minutesTotal && <> · נותרו {minutesLabel(m.minutesRemaining)}</>}
                {m.expiresAt && m.state === "OPEN" && <> · בתוקף עד {dateLabel(m.expiresAt.slice(0, 10))}</>}
                {" "}<span className="text-xs text-stone-500">({MAKEUP_STATE_TEXT[m.state] ?? m.state})</span>
              </li>
            ))}
          </ul>
          {shift.makeupOwed > 0 && (
            <p className="text-stone-600">
              את השעות אפשר לממש בהזמנת חדר ב&quot;יתרת שעות&quot; (אישור מהיתרה), או בתיאום עם ההנהלה. אין שינוי בחיוב המשמרת.
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>מועד חיוב</th>
              <th>מפגשים בתקופה</th>
              <th>סכום חיוב</th>
              <th>מצב</th>
            </tr>
          </thead>
          <tbody>
            {shift.months.map((m) => {
              const cs = m.chargeStatus ? CHARGE_STATUS_TEXT[m.chargeStatus] : null;
              return (
                <tr key={m.month}>
                  <td className="tabular-nums">{m.dueDate ? dateLabel(m.dueDate) : monthLabel(m.month)}</td>
                  <td className="tabular-nums">{m.count}</td>
                  <td className="tabular-nums">{shekel(m.amountAgorot)}</td>
                  <td>
                    {cs ? (
                      <ToneBadge tone={cs.tone}>{m.manual ? "שולם (ידני)" : cs.label}</ToneBadge>
                    ) : (
                      <span className="text-stone-400 text-xs">{shift.paymentMode === "MANUAL" ? "ממתין לתשלום" : "יחויב במועד"}</span>
                    )}
                    {m.manual && <span className="block text-xs text-stone-500">התקבל ב-{dateLabel(m.manual.paidOn)}</span>}
                    {m.failureCode && m.chargeStatus === "FAILED" && <span className="block text-xs text-red-600 mt-1">{failureText(m.failureCode)}</span>}
                    {m.graceUntil && m.chargeStatus === "FAILED" && <span className="block text-xs text-stone-500">תקופת חסד עד {dateLabel(m.graceUntil.slice(0, 10))}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shift.nextCharge && (
        <p className="text-sm text-stone-600">
          החיוב הבא: <strong>{shekel(shift.nextCharge.amountAgorot)}</strong>
          {shift.nextCharge.dueDate ? ` ב-${dateLabel(shift.nextCharge.dueDate)}` : ` בתחילת ${monthLabel(shift.nextCharge.month)}`}.
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-stone-700">
          מופעים ({shift.counts.scheduled} מתוזמנים{shift.counts.skipped ? `, ${shift.counts.skipped} דולגו` : ""}{shift.counts.cancelled ? `, ${shift.counts.cancelled} בוטלו` : ""})
        </summary>
        {shift.upcoming.length > 0 ? (
          <ul className="mt-2 text-sm text-stone-600 space-y-1">
            {shift.upcoming.map((o) => (
              <li key={o.date} className="tabular-nums">
                {dateLabel(o.date)} · {jerusalemTime(o.startTime)}–{jerusalemTime(o.endTime)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-stone-500">אין מופעים עתידיים.</p>
        )}
      </details>

      {shift.charges.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">היסטוריית חיובים ({shift.charges.length})</summary>
          <ul className="mt-2 divide-y divide-cream-100 text-sm">
            {shift.charges.map((c) => {
              const cs = CHARGE_STATUS_TEXT[c.status] ?? { label: c.status, tone: "neutral" as const };
              return (
                <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {c.dueDate ? dateLabel(c.dueDate) : monthLabel(c.month)} · <strong className="tabular-nums">{shekel(c.amountAgorot)}</strong>
                    {c.refundedAgorot > 0 && <span className="text-brand-700"> (הוחזרו {shekel(c.refundedAgorot)})</span>}
                  </span>
                  <ToneBadge tone={cs.tone}>{cs.label}</ToneBadge>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {latest && (
        <p className="text-sm rounded-xl bg-cream-50 ring-1 ring-cream-200 px-4 py-3" data-testid="request-status">
          בקשת {REQUEST_KIND_TEXT[latest.kind]}:{" "}
          <ToneBadge tone={REQUEST_STATUS_TEXT[latest.status].tone}>{REQUEST_STATUS_TEXT[latest.status].label}</ToneBadge>
          {latest.status === "PENDING" && " המשמרת נשארת כפי שהיא עד שמנהל יחליט."}
          {latest.decisionNote && <span className="block mt-1 text-stone-500">הערת מנהל: {latest.decisionNote}</span>}
          {latest.status === "APPROVED" && latest.appliedFrom && <span className="block mt-1 text-stone-500">בתוקף מ-{dateLabel(latest.appliedFrom)}</span>}
        </p>
      )}

      {canRequest && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("CHANGE")}>
            פנייה למנהל: שינוי
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("CANCEL")}>
            פנייה למנהל: ביטול
          </button>
        </div>
      )}

      {dialog && (
        <RequestDialog
          shift={shift}
          windows={windows}
          kind={dialog}
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null);
            onNotice("הפנייה נשלחה וממתינה להחלטת מנהל. המשמרת נשארת ללא שינוי עד אז.");
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function RequestDialog({ shift, windows, kind, onClose, onSent }: { shift: ShiftView; windows: ShiftWindowDef[]; kind: "CHANGE" | "CANCEL"; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [roomKey, setRoomKey] = useState("");
  const [weekday, setWeekday] = useState("");
  const [windowId, setWindowId] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  async function submit() {
    await run(async () => {
      setError(null);
      const body = {
        kind,
        reason,
        requestedFrom: from || undefined,
        proposed:
          kind === "CHANGE"
            ? { roomKey: roomKey || undefined, weekday: weekday === "" ? undefined : Number(weekday), windowId: windowId || undefined }
            : undefined,
      };
      const res = await api(`/api/shifts/${shift.id}/requests`, { body });
      if (res.ok) onSent();
      else setError(res.data.error ?? "לא ניתן לשלוח את הבקשה");
    });
  }

  return (
    <Dialog title={kind === "CANCEL" ? "פנייה למנהל: ביטול משמרת" : "פנייה למנהל: שינוי משמרת"} labelId={`req-${shift.id}`} onClose={onClose}>
      <p className="text-sm text-stone-600">
        המשמרת היא התחייבות לשלושה חודשים, ולכן שינוי או ביטול אפשריים רק באישור מנהל. הפנייה <strong>אינה משנה דבר ואינה מבצעת החזר אוטומטי</strong>:
        היא תיבדק על ידי מנהל, ועד להחלטתו המשמרת והחיובים נשארים כפי שהם. היעדרות ממפגש אינה מזכה בהחזר או בזיכוי.
        {kind === "CHANGE" && " שינוי נכנס לתוקף רק מתקופת חיוב שטרם חויבה."}
      </p>
      {kind === "CHANGE" && (
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="field-label" htmlFor="rq-room">חדר</label>
            <select id="rq-room" className="field" value={roomKey} onChange={(e) => setRoomKey(e.target.value)}>
              <option value="">ללא שינוי</option>
              {ROOM_KEYS.map((k) => (
                <option key={k} value={k}>{ROOM_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="rq-day">יום</label>
            <select id="rq-day" className="field" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              <option value="">ללא שינוי</option>
              {WEEKDAY_NAMES.map((n, i) => (
                <option key={n} value={i}>{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="rq-win">משבצת</label>
            <select id="rq-win" className="field" value={windowId} onChange={(e) => setWindowId(e.target.value)}>
              <option value="">ללא שינוי</option>
              {windows.filter((w) => w.active).map((w) => (
                <option key={w.id} value={w.id}>{windowLabelOf(w)}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div>
        <label className="field-label" htmlFor="rq-from">
          החל מתאריך <span className="font-normal text-stone-400">(לא חובה)</span>
        </label>
        <input id="rq-from" type="date" className="field" value={from} min={todayIsoDate()} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div>
        <label className="field-label" htmlFor="rq-reason">
          סיבה <span className="font-normal text-stone-400">(לא חובה)</span>
        </label>
        <textarea id="rq-reason" className="field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>חזרה</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? "שולח..." : "שליחת פנייה"}
        </button>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── הזמנת משמרת חדשה ─────────────────────────────

function NewShift({ windows, hasCard, mockCardLink, onCreated }: { windows: ShiftWindowDef[]; hasCard: boolean; mockCardLink: boolean; onCreated: (message: string) => void }) {
  const [roomKey, setRoomKey] = useState<string>("ROOM3");
  const [weekday, setWeekday] = useState(1);
  const activeWindows = windows.filter((w) => w.active);
  const [windowId, setWindowId] = useState(activeWindows[0]?.id ?? "");
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [plan, setPlan] = useState<Preview | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ date: string; reason: string }[]>([]);
  const preview = useSingleFlight();
  const create = useSingleFlight();
  // מפתח אידמפוטנטיות אחד לכל "כוונת הזמנה": לחיצה כפולה או רענון חוזרים לאותה משמרת ולא ליצירה שנייה
  const clientKey = useRef(newKey());

  const reset = () => {
    setPlan(null);
    setConflicts([]);
    setError(null);
    clientKey.current = newKey();
  };

  async function doPreview() {
    await preview.run(async () => {
      setError(null);
      const res = await api<Preview>("/api/shifts/preview", { body: { roomKey, weekday, windowId, startDate } });
      if (res.ok) setPlan(res.data as Preview);
      else {
        setPlan(null);
        setError(res.data.error ?? "לא ניתן לחשב תצוגה מקדימה");
      }
    });
  }

  async function doCreate() {
    await create.run(async () => {
      setError(null);
      setConflicts([]);
      const res = await api<{ status?: string; shiftId?: string; failureCode?: string; conflicts?: { date: string; reason: string }[] }>("/api/shifts", {
        body: { roomKey, weekday, windowId, startDate, clientKey: clientKey.current, currentPassword: password },
      });
      setPassword("");
      if (res.ok && res.data.status === "ACTIVE") {
        reset();
        onCreated("המשמרת אושרה והחיוב הראשון בוצע.");
        return;
      }
      if (res.status === 202) {
        reset();
        onCreated("המשמרת נשמרה, אך מצב החיוב הראשון בבירור. המשבצות שמורות ומנהל יטפל.");
        return;
      }
      if (res.data.status === "CHARGE_FAILED") {
        setError(`החיוב הראשון נכשל${res.data.failureCode ? ` (${failureText(res.data.failureCode)})` : ""}, לכן המשמרת לא אושרה והמשבצות שוחררו.`);
        clientKey.current = newKey();
        return;
      }
      if (res.data.code === "NO_PAYMENT_METHOD") setError("יש לשמור אמצעי תשלום באזור האישי לפני הזמנת משמרת.");
      else setError(res.data.error ?? "לא ניתן ליצור את המשמרת");
      if (res.data.conflicts) setConflicts(res.data.conflicts);
      if (res.data.code === "CONFLICT") clientKey.current = newKey();
    });
  }

  const select = "field";
  return (
    <div className="card p-5 sm:p-6 space-y-5" data-testid="new-shift">
      {!hasCard && (
        <p className="rounded-xl border border-bronze-200 bg-bronze-50 px-4 py-3 text-sm text-bronze-700" data-testid="no-card">
          כדי להזמין משמרת צריך אמצעי תשלום שמור וזמין, כי החיוב החודשי מתבצע בו.{" "}
          {mockCardLink ? (
            <Link href="/profile/payment-method" className="underline font-semibold">
              לשמירת אמצעי תשלום
            </Link>
          ) : (
            "יש לשמור אמצעי תשלום באזור האישי."
          )}
        </p>
      )}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4" onChange={reset}>
        <div>
          <label className="field-label" htmlFor="ns-room">חדר</label>
          <select id="ns-room" className={select} value={roomKey} onChange={(e) => setRoomKey(e.target.value)}>
            {ROOM_KEYS.map((k) => (
              <option key={k} value={k}>{ROOM_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="ns-day">יום בשבוע</label>
          <select id="ns-day" className={select} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAY_NAMES.map((n, i) => (
              <option key={n} value={i}>{n}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="ns-window">משבצת</label>
          <select id="ns-window" className={select} value={windowId} onChange={(e) => setWindowId(e.target.value)}>
            {activeWindows.map((w) => (
              <option key={w.id} value={w.id}>
                {windowLabelOf(w)} · {shekel(w.monthlyPriceAgorot)} לחודש
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="ns-start">תאריך התחלה</label>
          <input id="ns-start" type="date" className={select} value={startDate} min={todayIsoDate()} onChange={(e) => setStartDate(e.target.value)} />
          {startDate && weekdayOf(startDate) !== weekday && <p className="text-xs text-stone-400 mt-1">המופע הראשון יהיה ביום {WEEKDAY_NAMES[weekday]} הקרוב</p>}
        </div>
      </div>

      <button type="button" className="btn btn-secondary" disabled={preview.busy || !startDate} onClick={doPreview}>
        {preview.busy ? "מחשב..." : "תצוגה מקדימה ופירוט חיוב"}
      </button>

      {error && <Alert tone="error">{error}</Alert>}
      {conflicts.length > 0 && <ConflictList conflicts={conflicts} />}

      {plan && (
        <div className="space-y-4" data-testid="preview">
          {plan.conflicts.length > 0 ? (
            <>
              <Alert tone="error">לא ניתן להזמין משמרת בבחירה הזו. בחרו חדר, יום, משבצת או תאריך אחרים.</Alert>
              <ConflictList conflicts={plan.conflicts} />
            </>
          ) : null}

          <div className="rounded-xl bg-cream-50 ring-1 ring-cream-200 p-4 text-sm space-y-2">
            <p>
              תקופה: <strong>{dateLabel(plan.startDate)}</strong> עד <strong>{dateLabel(plan.endDate)}</strong> (שלושה חודשים, ללא חידוש אוטומטי). מחיר חודשי קבוע:{" "}
              <strong>{shekel(plan.monthlyPriceAgorot)}</strong> (כולל מע&quot;מ), בסך הכול <strong>{shekel(plan.totalAgorot)}</strong> לשלושה חודשים.
            </p>
            <ul className="divide-y divide-cream-200">
              {plan.months.map((m) => (
                <li key={m.month} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    חיוב {dateLabel(m.dueDate)}: {m.count} מפגשים בתקופה
                  </span>
                  <span className="tabular-nums">
                    <strong>{shekel(m.amountAgorot)}</strong>{" "}
                    <span className="text-xs text-stone-500">{m.isFirst ? "ייגבה מיד באישור ההזמנה" : "ייגבה אוטומטית במועדו"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-semibold text-stone-700">פירוט המופעים ({plan.occurrences.length})</summary>
            <ul className="mt-2 text-sm text-stone-600 divide-y divide-cream-100">
              {plan.occurrences.map((o) => (
                <li key={o.date} className="py-1.5 flex items-center justify-between gap-2 tabular-nums">
                  <span>
                    {dateLabel(o.date)} · {jerusalemTime(o.startTime)}–{jerusalemTime(o.endTime)}
                  </span>
                  <span className="text-stone-400">{o.skipReason ? `${OCCURRENCE_STATUS_TEXT.SKIPPED_CLOSED_DAY} · שעה חלופית` : "כלול במחיר"}</span>
                </li>
              ))}
            </ul>
          </details>

          <ul className="text-xs text-stone-500 space-y-1 list-disc pr-5">
            <li>שלושה חיובים בדיוק, בסכום קבוע: הראשון מיד באישור ההזמנה (גם אם תאריך ההתחלה עתידי), והשניים הבאים חודש וחודשיים אחרי תאריך ההתחלה. אין חישוב יחסי, וכל המפגשים בתקופה כלולים במחיר.</li>
            <li>ההזמנה מאושרת רק אחרי תשלום ראשון מוצלח. אם התשלום נכשל המשבצות משתחררות מיד.</li>
            <li>אם חיוב נכשל, תקופת חסד של שבעה ימים. אם החוב לא הוסדר, המשמרת מושעית, המשבצות נשמרות והשימוש בה נעצר עד החלטת מנהל.</li>
            <li>שינוי או ביטול במהלך התקופה אפשריים רק בפנייה למנהל ובאישורו. היעדרות ממפגש אינה מזכה בהחזר או בזיכוי. אם ההנהלה סוגרת את הקליניקה, תקבלו שעה חלופית.</li>
          </ul>

          {plan.conflicts.length === 0 && hasCard && (
            <div className="space-y-3">
              <div>
                <label className="field-label" htmlFor="ns-password">סיסמת האתר (לאישור ההתחייבות)</label>
                <input id="ns-password" type="password" dir="ltr" autoComplete="current-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <button type="button" className="btn btn-primary w-full py-3!" disabled={create.busy || !password} onClick={doCreate}>
                {create.busy
                  ? "יוצר משמרת..."
                  : `אישור והזמנה · חיוב מיידי ${shekel(plan.firstChargeAgorot)}`}
                {!create.busy && <Icon name="arrowLeft" className="w-4 h-4" />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConflictList({ conflicts }: { conflicts: { date: string; reason: string }[] }) {
  return (
    <ul className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3 space-y-1">
      {conflicts.slice(0, 12).map((c) => (
        <li key={c.date + c.reason}>
          {c.date ? `${dateLabel(c.date)}: ` : ""}
          {c.reason}
        </li>
      ))}
      {conflicts.length > 12 && <li>ועוד {conflicts.length - 12} תאריכים</li>}
    </ul>
  );
}
