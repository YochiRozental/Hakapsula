"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, EmptyState, Loading, SectionTitle } from "@/components/ui";
import { Dialog, ToneBadge } from "@/components/shifts/bits";
import { api, shekel, useSingleFlight } from "@/lib/payments/client";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { DEBT_STATUS, Money, PURPOSE_LABEL, REFUND_STATE, fmtDate, fmtDateTime, toAgorot, useIntentKey } from "@/components/finance/bits";

const APPOINTMENT_STATUS: Record<string, string> = { CONFIRMED: "מאושרת", CANCELLED: "מבוטלת", PENDING_PAYMENT: "ממתינה לתשלום" };

type Tell = (tone: "success" | "error", text: string) => void;
interface Props {
  version: number;
  onChanged: () => void;
  tell: Tell;
}

// ───────────────────────────── חובות ─────────────────────────────

export interface DebtView {
  id: string;
  user: { id: string; name: string; email: string | null; phone: string | null; status: string };
  status: string;
  classification: string;
  amountAgorot: number;
  paidAgorot: number;
  waivedAgorot: number;
  remainingAgorot: number;
  reason: string | null;
  reviewNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  source: { kind: "BOOKING"; appointmentId: string; roomName: string; startTime: string; endTime: string; appointmentStatus: string } | { kind: "MANUAL" };
  settlements: { id: string; kind: string; amountAgorot: number; method: string | null; reference: string | null; reason: string | null; paymentId: string | null; createdAt: string }[];
}

export function DebtsTab({ version, onChanged, tell }: Props) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [rows, setRows] = useState<DebtView[] | null>(null);
  const [open, setOpen] = useState<DebtView | null>(null);
  const [booking, setBooking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (q) p.set("q", q);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    const lo = toAgorot(min);
    const hi = toAgorot(max);
    if (lo) p.set("min", String(lo));
    if (hi) p.set("max", String(hi));
    const t = setTimeout(async () => {
      const r = await api<{ debts: DebtView[] }>(`/api/admin/finance/debts?${p}`);
      if (!cancelled && r.ok) setRows((r.data as { debts: DebtView[] }).debts);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [status, q, from, to, min, max, version]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle hint="חוב פתוח אינו חוסם הזמנות. רק חסימה מפורשת של לקוח חוסמת">חובות</SectionTitle>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setBooking(true)}>
          אישור הזמנה עם חוב
        </button>
      </div>
      <div className="card p-4 grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
        <input aria-label="לקוח" className="field" placeholder="לקוח" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="סטטוס חוב" className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">כל הסטטוסים</option>
          {Object.entries(DEBT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <input aria-label="מתאריך" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input aria-label="עד תאריך" type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
        <input aria-label="סכום מינימלי בשקלים" className="field" inputMode="decimal" placeholder="מ-₪" value={min} onChange={(e) => setMin(e.target.value)} />
        <input aria-label="סכום מקסימלי בשקלים" className="field" inputMode="decimal" placeholder="עד ₪" value={max} onChange={(e) => setMax(e.target.value)} />
      </div>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon="list">אין חובות תואמים.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base" data-testid="debts-table">
            <thead>
              <tr>
                <th>לקוח</th>
                <th>מקור</th>
                <th>סכום חוב</th>
                <th>שולם</th>
                <th>נמחל</th>
                <th>יתרה</th>
                <th>סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const st = DEBT_STATUS[d.status] ?? { label: d.status, tone: "neutral" as const };
                return (
                  <tr key={d.id} className="cursor-pointer hover:bg-cream-50" onClick={() => setOpen(d)}>
                    <td>
                      <button type="button" className="font-semibold text-brand-700 underline" onClick={() => setOpen(d)}>
                        {d.user.name}
                      </button>
                    </td>
                    <td className="text-xs">{d.source.kind === "BOOKING" ? `הזמנה · ${d.source.roomName} · ${fmtDateTime(d.source.startTime)}` : "ידני"}</td>
                    <td><Money agorot={d.amountAgorot} /></td>
                    <td><Money agorot={d.paidAgorot} /></td>
                    <td><Money agorot={d.waivedAgorot} /></td>
                    <td><Money agorot={d.remainingAgorot} strong /></td>
                    <td><ToneBadge tone={st.tone}>{st.label}</ToneBadge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <DebtDialog debt={open} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); tell("success", t); onChanged(); }} onError={(t) => tell("error", t)} />}
      {booking && <DebtBookingDialog onClose={() => setBooking(false)} onDone={(t) => { setBooking(false); tell("success", t); onChanged(); }} />}
    </section>
  );
}

export function DebtDialog({ debt, onClose, onDone, onError }: { debt: DebtView; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [mode, setMode] = useState<"settle" | "waive" | "review" | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const key = useIntentKey();
  const { busy, run } = useSingleFlight();
  const open = debt.status === "OPEN";
  const inReview = debt.status === "IN_REVIEW";

  async function submit() {
    await run(async () => {
      const agorot = amount.trim() ? toAgorot(amount) : debt.remainingAgorot;
      if (mode !== "review" && !agorot) return onError("סכום לא תקין");
      const url = `/api/admin/finance/debts/${debt.id}/${mode}`;
      const body =
        mode === "settle"
          ? { amountAgorot: agorot, reference, confirmedExternalPayment: confirm, note: reason || undefined, clientKey: key.get() }
          : mode === "waive"
            ? { amountAgorot: agorot, reason, clientKey: key.get() }
            : { inReview: open, note: reason };
      const r = await api(url, { body });
      if (r.ok) {
        key.renew();
        onDone(mode === "settle" ? "ההסדרה נרשמה" : mode === "waive" ? "הוויתור נרשם" : "מצב הבירור עודכן");
      } else onError(r.data.error ?? "הפעולה נכשלה");
    });
  }

  return (
    <Dialog title="פרטי חוב" labelId="debt-dlg" onClose={onClose}>
      <div className="space-y-3 text-sm" data-testid="debt-dialog">
        <p>
          <strong>{debt.user.name}</strong> · <ToneBadge tone={(DEBT_STATUS[debt.status] ?? DEBT_STATUS.OPEN).tone}>{(DEBT_STATUS[debt.status] ?? DEBT_STATUS.OPEN).label}</ToneBadge>
          <Link className="mr-3 text-brand-700 underline" href={`/admin/finance/customers/${debt.user.id}`}>כרטיס לקוח</Link>
        </p>
        <p>
          סכום חוב: <Money agorot={debt.amountAgorot} /> · שולם בפועל: <Money agorot={debt.paidAgorot} /> · נמחל: <Money agorot={debt.waivedAgorot} /> · <strong>יתרה: <Money agorot={debt.remainingAgorot} /></strong>
        </p>
        <p className="text-stone-500">
          מקור: {debt.source.kind === "BOOKING" ? `הזמנה (${debt.source.roomName}, ${fmtDateTime(debt.source.startTime)}, ${APPOINTMENT_STATUS[debt.source.appointmentStatus] ?? debt.source.appointmentStatus})` : "ידני"} · נוצר {fmtDate(debt.createdAt)}
          {debt.reason ? ` · ${debt.reason}` : ""}
        </p>
        {debt.reviewNote && <Alert tone="error">בבירור: {debt.reviewNote}</Alert>}
        <div>
          <h3 className="font-semibold mb-1">תשלומים והסדרות</h3>
          {debt.settlements.length === 0 ? (
            <p className="text-stone-500">עדיין לא בוצעו.</p>
          ) : (
            <ul className="divide-y divide-cream-100">
              {debt.settlements.map((s) => (
                <li key={s.id} className="py-1.5 flex flex-wrap justify-between gap-2">
                  <span>
                    {s.kind === "PAYMENT" ? `תשלום (${s.method === "EXTERNAL" ? "חיצוני" : s.method}) אסמכתה: ${s.reference ?? "—"}` : `ויתור: ${s.reason ?? ""}`}
                    <span className="text-xs text-stone-400 mr-2">{fmtDateTime(s.createdAt)}</span>
                  </span>
                  <Money agorot={s.amountAgorot} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {!mode && (open || inReview) && (
          <div className="flex flex-wrap gap-2 border-t border-cream-200 pt-3">
            {open && <button type="button" className="btn btn-primary btn-sm" onClick={() => setMode("settle")}>רישום תשלום חיצוני (הסדרה)</button>}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode("waive")}>ויתור</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode("review")}>{open ? "העברה לבירור" : "החזרה לפתוח"}</button>
          </div>
        )}

        {mode && (
          <div className="space-y-2 border-t border-cream-200 pt-3">
            {mode !== "review" && (
              <div>
                <label className="field-label" htmlFor="dd-amount">סכום בשקלים (ריק = כל היתרה: {shekel(debt.remainingAgorot)})</label>
                <input id="dd-amount" className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
            {mode === "settle" && (
              <>
                <div>
                  <label className="field-label" htmlFor="dd-ref">אסמכתה (מספר קבלה / העברה)</label>
                  <input id="dd-ref" className="field" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                  <span>אני מאשר/ת במפורש שהתשלום התקבל בפועל מחוץ למערכת (המערכת לא מחייבת את הכרטיס השמור של הלקוח)</span>
                </label>
              </>
            )}
            <div>
              <label className="field-label" htmlFor="dd-reason">{mode === "settle" ? "הערה (לא חובה)" : "סיבה (חובה)"}</label>
              <textarea id="dd-reason" className="field" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setMode(null)}>ביטול</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || (mode === "settle" && (!confirm || reference.trim().length < 3)) || (mode !== "settle" && reason.trim().length < 3)} onClick={submit}>
                {busy ? "שומר..." : "אישור הפעולה"}
              </button>
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" className="btn btn-secondary" onClick={onClose}>סגירה</button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── אישור הזמנה עם חוב ─────────────────────────────

interface Quote {
  customer: { id: string; name: string };
  room: string;
  startTime: string;
  endTime: string;
  bookingAmountAgorot: number;
  debtAgorot: number;
  available: boolean;
  unavailableReason: string | null;
  inPast: boolean;
}

export function DebtBookingDialog({ onClose, onDone, presetUser }: { onClose: () => void; onDone: (t: string) => void; presetUser?: { id: string; name: string } }) {
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<{ id: string; name: string; email: string | null; phone: string | null }[]>([]);
  const [user, setUser] = useState<{ id: string; name: string } | null>(presetUser ?? null);
  const [roomKey, setRoomKey] = useState<string>("ROOM1");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("10:00");
  const [duration, setDuration] = useState(60);
  const [reason, setReason] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  useEffect(() => {
    if (search.trim().length < 2) return;
    const t = setTimeout(async () => {
      const r = await api<{ customers: typeof people }>(`/api/admin/finance/customers?q=${encodeURIComponent(search)}`);
      if (r.ok) setPeople((r.data as { customers: typeof people }).customers);
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const input = user ? { userId: user.id, roomKey, date, start, durationMinutes: duration } : null;

  async function doQuote() {
    await run(async () => {
      setError(null);
      setConfirm(false);
      const r = await api<Quote>("/api/admin/finance/bookings/quote", { body: input });
      if (r.ok) setQuote(r.data as Quote);
      else {
        setQuote(null);
        setError(r.data.error ?? "לא ניתן לחשב");
      }
    });
  }

  async function doApprove() {
    await run(async () => {
      setError(null);
      const r = await api<{ debtAgorot: number }>("/api/admin/finance/bookings", { body: { ...input, reason: reason || undefined, confirm: true, expectedDebtAgorot: quote!.debtAgorot } });
      if (r.ok) onDone(`ההזמנה אושרה ונוצר חוב בסך ${shekel((r.data as { debtAgorot: number }).debtAgorot)}`);
      else setError(r.data.error ?? "האישור נכשל");
    });
  }

  const reset = () => {
    setQuote(null);
    setConfirm(false);
  };

  return (
    <Dialog title="אישור הזמנה ללא תשלום מראש (עם חוב)" labelId="debt-booking" onClose={onClose}>
      <div className="space-y-3 text-sm" data-testid="debt-booking">
        {!user ? (
          <div>
            <label className="field-label" htmlFor="db-search">לקוח</label>
            <input id="db-search" className="field" placeholder="שם, אימייל או טלפון" value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul className="mt-2 divide-y divide-cream-100">
              {people.map((p) => (
                <li key={p.id}>
                  <button type="button" className="w-full text-start py-1.5 hover:bg-cream-50" onClick={() => setUser({ id: p.id, name: p.name })}>
                    {p.name} <span className="text-xs text-stone-500">{p.email ?? p.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>
            לקוח: <strong>{user.name}</strong>{" "}
            {!presetUser && <button type="button" className="text-brand-700 underline" onClick={() => { setUser(null); reset(); }}>החלפה</button>}
          </p>
        )}
        {user && (
          <>
            <div className="grid sm:grid-cols-2 gap-3" onChange={reset}>
              <div>
                <label className="field-label" htmlFor="db-room">חדר</label>
                <select id="db-room" className="field" value={roomKey} onChange={(e) => setRoomKey(e.target.value)}>
                  {ROOM_KEYS.map((k) => <option key={k} value={k}>{ROOM_LABELS[k]}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="db-date">תאריך</label>
                <input id="db-date" type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="db-start">שעת התחלה</label>
                <input id="db-start" type="time" step={900} className="field" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="db-dur">משך (דקות)</label>
                <input id="db-dur" type="number" min={15} step={15} className="field" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="db-reason">סיבה / הערה</label>
              <input id="db-reason" className="field" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button type="button" className="btn btn-secondary" disabled={busy || !date} onClick={doQuote}>הצגת סכומים</button>
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {quote && (
          <div className="rounded-xl bg-cream-50 ring-1 ring-cream-200 p-4 space-y-2" data-testid="debt-quote">
            <p>
              {quote.room} · {fmtDateTime(quote.startTime)}–{new Date(quote.endTime).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" })}
            </p>
            <p>סכום ההזמנה: <Money agorot={quote.bookingAmountAgorot} strong /></p>
            <p>חוב שייווצר: <Money agorot={quote.debtAgorot} strong /> (הלקוח לא משלם עכשיו; אין שימוש ביתרות)</p>
            {!quote.available && <Alert tone="error">{quote.unavailableReason ?? "החדר אינו זמין"}. לא ניתן לאשר.</Alert>}
            {quote.inPast && <Alert tone="error">הזמן כבר עבר.</Alert>}
            {quote.available && !quote.inPast && (
              <>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                  <span>אני מאשר/ת ליצור הזמנה מאושרת ללקוח ללא תשלום, ולרשום חוב פתוח בסכום {shekel(quote.debtAgorot)}</span>
                </label>
                <button type="button" className="btn btn-primary" disabled={busy || !confirm} onClick={doApprove}>אישור ההזמנה ויצירת החוב</button>
              </>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" className="btn btn-secondary" onClick={onClose}>סגירה</button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── החזרים ─────────────────────────────

interface RefundRow {
  id: string;
  state: string;
  amountAgorot: number;
  reason: string | null;
  createdAt: string;
  user: { id: string; name: string };
  payment: { id: string; purpose: string; amountAgorot: number; provider: string; appointmentId: string | null };
  refundableLeftAgorot: number;
}
interface ExceptionRow {
  appointmentId: string;
  user: { id: string; name: string };
  roomName: string;
  startTime: string;
  refundableAgorot: number;
  unrestoredMinutes: number;
  hasOpenDebt: boolean;
}

export function RefundsTab({ version, onChanged, tell }: Props) {
  const [refunds, setRefunds] = useState<RefundRow[] | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [deciding, setDeciding] = useState<ExceptionRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    api<{ refunds: RefundRow[]; exceptions: ExceptionRow[] }>(`/api/admin/finance/refunds?${p}`).then((r) => {
      if (cancelled || !r.ok) return;
      setRefunds((r.data as { refunds: RefundRow[] }).refunds);
      setExceptions((r.data as { exceptions: ExceptionRow[] }).exceptions);
    });
    return () => {
      cancelled = true;
    };
  }, [status, from, to, version]);

  return (
    <section className="space-y-6">
      <div>
        <SectionTitle hint="הזמנות שבוטלו מאוחר (פחות מ-24 שעות). אין החזר אוטומטי; המנהל מאשר חריגה או דוחה">חריגי החזר להכרעה</SectionTitle>
        {exceptions.length === 0 ? (
          <EmptyState icon="card">אין חריגים ממתינים.</EmptyState>
        ) : (
          <ul className="card divide-y divide-cream-100 mt-3" data-testid="exceptions">
            {exceptions.map((e) => (
              <li key={e.appointmentId} className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                <span>
                  <strong>{e.user.name}</strong> · {e.roomName} · {fmtDateTime(e.startTime)}
                  <span className="block text-xs text-stone-500">
                    ניתן להחזיר: {shekel(e.refundableAgorot)} · דקות שלא הוחזרו: {e.unrestoredMinutes}
                    {e.hasOpenDebt ? " · יש חוב פתוח" : ""}
                  </span>
                </span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setDeciding(e)}>הכרעה</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        <SectionTitle hint="החזר נחשב מוצלח רק אחרי אישור הספק. החזר 'מצב לא ידוע' מטופל בלשונית תור בירור">החזרים</SectionTitle>
        <div className="card p-4 grid sm:grid-cols-3 gap-3">
          <select aria-label="סטטוס החזר" className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">כל הסטטוסים</option>
            <option value="SUCCEEDED">בוצע</option>
            <option value="PENDING">ממתין</option>
            <option value="FAILED">נכשל</option>
          </select>
          <input aria-label="מתאריך" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label="עד תאריך" type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {!refunds ? (
          <Loading />
        ) : refunds.length === 0 ? (
          <EmptyState icon="card">אין החזרים.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="table-base" data-testid="refunds-table">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>לקוח</th>
                  <th>סכום החזר</th>
                  <th>תשלום מקורי</th>
                  <th>מצב</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => {
                  const st = REFUND_STATE[r.state] ?? { label: r.state, tone: "neutral" as const };
                  return (
                    <tr key={r.id}>
                      <td className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</td>
                      <td>{r.user.name}</td>
                      <td><Money agorot={r.amountAgorot} /></td>
                      <td className="text-xs">
                        {PURPOSE_LABEL[r.payment.purpose] ?? r.payment.purpose} · <Money agorot={r.payment.amountAgorot} />
                      </td>
                      <td><ToneBadge tone={st.tone}>{st.label}</ToneBadge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deciding && <ExceptionDialog row={deciding} onClose={() => setDeciding(null)} onDone={(t) => { setDeciding(null); tell("success", t); onChanged(); }} onError={(t) => tell("error", t)} />}
    </section>
  );
}

function ExceptionDialog({ row, onClose, onDone, onError }: { row: ExceptionRow; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const [waiveDebt, setWaiveDebt] = useState(false);
  const { busy, run } = useSingleFlight();
  async function decide(decision: "APPROVE" | "REJECT") {
    await run(async () => {
      const r = await api(`/api/admin/finance/refund-exceptions/${row.appointmentId}`, { body: { decision, reason, waiveDebt } });
      if (r.ok) onDone(decision === "APPROVE" ? "החריג אושר" : "הבקשה נדחתה");
      else onError(r.data.error ?? "הפעולה נכשלה");
    });
  }
  return (
    <Dialog title={`חריג החזר · ${row.user.name}`} labelId="exc" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>אישור יחזיר עד {shekel(row.refundableAgorot)} דרך הספק, יחזיר דקות שנוצלו ({row.unrestoredMinutes}) לפי מדיניות החזרת הדקות, ויתועד ביומן.</p>
        {row.hasOpenDebt && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={waiveDebt} onChange={(e) => setWaiveDebt(e.target.checked)} />
            לוותר גם על החוב הפתוח של ההזמנה
          </label>
        )}
        <div>
          <label className="field-label" htmlFor="exc-reason">סיבה (חובה)</label>
          <textarea id="exc-reason" className="field" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>חזרה</button>
          <button type="button" className="btn btn-secondary" disabled={busy || reason.trim().length < 3} onClick={() => decide("REJECT")}>דחייה</button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => decide("APPROVE")}>אישור והחזר</button>
        </div>
      </div>
    </Dialog>
  );
}

/** החזר מנהל על תשלום (מכרטיס לקוח): סכום עד היתרה הניתנת להחזר, סיבה חובה */
export function RefundDialog({ paymentId, maxAgorot, onClose, onDone, onError }: { paymentId: string; maxAgorot: number; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [amount, setAmount] = useState(String(maxAgorot / 100));
  const [reason, setReason] = useState("");
  const [exception, setException] = useState(true);
  const key = useIntentKey();
  const { busy, run } = useSingleFlight();
  async function submit() {
    await run(async () => {
      const agorot = toAgorot(amount);
      if (!agorot) return onError("סכום לא תקין");
      const r = await api<{ status: string }>("/api/admin/finance/refunds", { body: { paymentId, amountAgorot: agorot, reason, exception, clientKey: key.get() } });
      if (r.ok || r.status === 202) {
        key.renew();
        const s = (r.data as { status?: string }).status;
        onDone(s === "SUCCEEDED" ? "ההחזר בוצע" : s === "UNKNOWN" ? "ההחזר נשלח אך מצבו לא ידוע. הוא בתור הבירור" : "ההחזר לא הושלם");
      } else onError(r.data.error ?? "ההחזר נכשל");
    });
  }
  return (
    <Dialog title="החזר מנהל" labelId="refund-dlg" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>ניתן להחזיר עד {shekel(maxAgorot)}. ההחזר מבוצע דרך ספק התשלום ומסומן מוצלח רק אחרי אישורו.</p>
        <div>
          <label className="field-label" htmlFor="rf-amount">סכום בשקלים</label>
          <input id="rf-amount" className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={exception} onChange={(e) => setException(e.target.checked)} />
          חריגה ממדיניות ההחזר האוטומטית
        </label>
        <div>
          <label className="field-label" htmlFor="rf-reason">סיבה (חובה)</label>
          <textarea id="rf-reason" className="field" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>חזרה</button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={submit}>{busy ? "מבצע..." : "ביצוע ההחזר"}</button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── בקשות ביטול חבילה ─────────────────────────────

interface PkgRequest {
  id: string;
  status: string;
  reason: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string | null; phone: string | null };
  package: {
    id: string;
    hours: number;
    pricePaidAgorot: number;
    minutesTotal: number;
    minutesConsumed: number;
    minutesRemaining: number;
    purchasedAt: string;
    expiresAt: string;
    expired: boolean;
    refundedAgorot: number;
    refundPendingAgorot: number;
    refundableAgorot: number;
    proportionalValueOfRemainingAgorot: number;
  };
}

export function PackageRequestsTab({ version, onChanged, tell }: Props) {
  const [rows, setRows] = useState<PkgRequest[] | null>(null);
  const [active, setActive] = useState<PkgRequest | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ requests: PkgRequest[] }>("/api/admin/finance/package-requests").then((r) => {
      if (!cancelled && r.ok) setRows((r.data as { requests: PkgRequest[] }).requests);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);
  return (
    <section className="space-y-4">
      <SectionTitle hint="החבילה נשארת פעילה עד ההחלטה. אין נוסחת החזר אוטומטית: המנהל קובע סכום, עד מה ששולם בפועל">בקשות ביטול חבילה</SectionTitle>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon="list">אין בקשות ממתינות.</EmptyState>
      ) : (
        <ul className="space-y-3" data-testid="pkg-requests">
          {rows.map((r) => (
            <li key={r.id} className="card p-4 space-y-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{r.user.name}</strong>
                <span className="text-xs text-stone-500">הוגשה {fmtDate(r.createdAt)}</span>
              </div>
              <p>
                חבילת {r.package.hours} שעות · מחיר רכישה <Money agorot={r.package.pricePaidAgorot} /> · תוקף עד {fmtDate(r.package.expiresAt)}
                {r.package.expired && " (פגה)"}
              </p>
              <p>
                דקות: נוצלו {r.package.minutesConsumed} · נותרו {r.package.minutesRemaining} מתוך {r.package.minutesTotal} · הוחזר עד כה <Money agorot={r.package.refundedAgorot} />
                {r.package.refundPendingAgorot > 0 && <> · החזר ממתין <Money agorot={r.package.refundPendingAgorot} /></>}
              </p>
              <p className="text-xs text-stone-500">
                ערך יחסי של הדקות שנותרו (מידע בלבד, לא נוסחת החזר): {shekel(r.package.proportionalValueOfRemainingAgorot)} · תקרת החזר: {shekel(r.package.refundableAgorot)}
              </p>
              {r.reason && <p className="text-stone-600">סיבת הלקוח: {r.reason}</p>}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setActive(r)}>טיפול בבקשה</button>
            </li>
          ))}
        </ul>
      )}
      {active && <PackageDecisionDialog row={active} onClose={() => setActive(null)} onDone={(t) => { setActive(null); tell("success", t); onChanged(); }} onError={(t) => tell("error", t)} />}
    </section>
  );
}

function PackageDecisionDialog({ row, onClose, onDone, onError }: { row: PkgRequest; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState("");
  const { busy, run } = useSingleFlight();
  async function decide(decision: "APPROVE" | "REJECT") {
    await run(async () => {
      const agorot = refund.trim() ? toAgorot(refund) : 0;
      if (refund.trim() && !agorot) return onError("סכום ההחזר לא תקין");
      const r = await api<{ refundStatus: string | null; forfeitedMinutes: number | null }>(`/api/admin/finance/package-requests/${row.id}`, { body: { decision, reason, refundAgorot: agorot || undefined } });
      if (r.ok || r.status === 202) {
        const d = r.data as { refundStatus: string | null; forfeitedMinutes: number | null };
        onDone(decision === "REJECT" ? "הבקשה נדחתה; החבילה נשארת פעילה" : `הבקשה אושרה. אופסו ${d.forfeitedMinutes ?? 0} דקות${d.refundStatus ? ` · החזר: ${d.refundStatus === "SUCCEEDED" ? "בוצע" : d.refundStatus === "UNKNOWN" ? "מצב לא ידוע (בתור הבירור)" : "נכשל"}` : ""}`);
      } else onError(r.data.error ?? "הפעולה נכשלה");
    });
  }
  return (
    <Dialog title={`ביטול חבילה · ${row.user.name}`} labelId="pkg-dec" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>היתרה תיקרא מחדש ברגע האישור (ייתכן שהלקוח ניצל שעות מאז ההגשה) ותאופס: לא יהיה ניצול נוסף. נותרו כרגע {row.package.minutesRemaining} דקות.</p>
        <div>
          <label className="field-label" htmlFor="pd-refund">סכום החזר בשקלים (ריק = ללא החזר כספי; עד {shekel(row.package.refundableAgorot)})</label>
          <input id="pd-refund" className="field" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="pd-reason">סיבת ההחלטה (חובה)</label>
          <textarea id="pd-reason" className="field" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>חזרה</button>
          <button type="button" className="btn btn-secondary" disabled={busy || reason.trim().length < 3} onClick={() => decide("REJECT")}>דחייה</button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => decide("APPROVE")}>אישור ביטול</button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── תור בירור ─────────────────────────────

interface UnknownItem {
  kind: "PAYMENT" | "REFUND" | "SHIFT_CHARGE";
  id: string;
  user: { id: string; name: string };
  amountAgorot: number;
  provider?: string;
  providerPaymentId?: string | null;
  idempotencyKey?: string;
  createdAt: string;
  original: string;
  verifiable?: boolean;
  sentToProvider?: boolean;
  shiftId?: string;
  inquiry: { status: string; notes: number; lastNote: string | null };
}
interface UnknownData {
  payments: UnknownItem[];
  refunds: UnknownItem[];
  shiftCharges: UnknownItem[];
}

const INQUIRY_TEXT: Record<string, string> = { AWAITING: "ממתין לבירור", NOTED: "בבירור (תועד)", VERIFIED_INCONCLUSIVE: "נבדק מול הספק: לא חד-משמעי" };

export function UnknownTab({ version, onChanged, tell }: Props) {
  const [data, setData] = useState<UnknownData | null>(null);
  const [active, setActive] = useState<UnknownItem | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<UnknownData>("/api/admin/finance/unknown").then((r) => {
      if (!cancelled && r.ok) setData(r.data as UnknownData);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);
  if (!data) return <Loading />;
  const items = [...data.payments, ...data.refunds, ...data.shiftCharges];
  return (
    <section className="space-y-4">
      <SectionTitle hint="פעולות שמצבן אינו ידוע. אימות מול הספק קודם; הכרעה ידנית רק עם אסמכתה וכשאי אפשר לאמת">תור בירור</SectionTitle>
      {items.length === 0 ? (
        <EmptyState icon="list">אין פעולות במצב לא ידוע.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base" data-testid="unknown-table">
            <thead>
              <tr>
                <th>סוג</th>
                <th>לקוח</th>
                <th>סכום</th>
                <th>ספק / מפתח</th>
                <th>תאריך</th>
                <th>הפעולה המקורית</th>
                <th>בירור</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={`${i.kind}:${i.id}`}>
                  <td>{i.kind === "PAYMENT" ? "תשלום" : i.kind === "REFUND" ? "החזר" : "חיוב משמרת"}</td>
                  <td>{i.user.name}</td>
                  <td><Money agorot={i.amountAgorot} /></td>
                  <td className="text-xs" dir="ltr">
                    {i.provider ?? "—"}
                    {i.idempotencyKey && <span className="block text-stone-400">{i.idempotencyKey}</span>}
                  </td>
                  <td className="text-xs tabular-nums">{fmtDateTime(i.createdAt)}</td>
                  <td className="text-xs">{i.original}</td>
                  <td className="text-xs">
                    <ToneBadge tone={i.inquiry.status === "AWAITING" ? "bad" : "pending"}>{INQUIRY_TEXT[i.inquiry.status] ?? i.inquiry.status}</ToneBadge>
                    {i.inquiry.lastNote && <span className="block text-stone-500">{i.inquiry.lastNote}</span>}
                  </td>
                  <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => setActive(i)}>טיפול</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {active && <UnknownDialog item={active} onClose={() => setActive(null)} onDone={(t) => { setActive(null); tell("success", t); onChanged(); }} onError={(t) => tell("error", t)} />}
    </section>
  );
}

function UnknownDialog({ item, onClose, onDone, onError }: { item: UnknownItem; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();
  const kind = item.kind === "PAYMENT" ? "payment" : item.kind === "REFUND" ? "refund" : "shift-charge";

  async function act(body: Record<string, unknown>, success: string) {
    await run(async () => {
      const r = await api<{ conclusion?: string }>(`/api/admin/finance/unknown/${kind}/${item.id}`, { body });
      if (!r.ok && r.status !== 202) return onError(r.data.error ?? "הפעולה נכשלה");
      const c = (r.data as { conclusion?: string }).conclusion;
      if (body.action === "verify" && (c === "UNVERIFIABLE" || c === "AMBIGUOUS" || c === "STILL_PENDING")) {
        setResult(c === "STILL_PENDING" ? "התשלום עדיין ממתין אצל הספק" : "הספק לא סיפק תשובה חד-משמעית. אפשר להכריע ידנית עם אסמכתה");
        return;
      }
      onDone(success);
    });
  }

  return (
    <Dialog title="טיפול בפעולה לא ברורה" labelId="unk" onClose={onClose}>
      <div className="space-y-3 text-sm" data-testid="unknown-dialog">
        <p>
          {item.original} · <Money agorot={item.amountAgorot} />
        </p>
        {result && <Alert tone="error">{result}</Alert>}
        {item.kind !== "SHIFT_CHARGE" && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || item.verifiable === false} onClick={() => act({ action: "verify" }, "האימות מול הספק הושלם")}>
            אימות מול הספק
          </button>
        )}
        {item.kind === "REFUND" && !item.sentToProvider && (
          <button type="button" className="btn btn-secondary btn-sm mr-2" disabled={busy} onClick={() => act({ action: "send" }, "ההחזר נשלח")}>
            שליחה לספק (טרם נשלח)
          </button>
        )}
        <div>
          <label className="field-label" htmlFor="un-note">תיעוד בירור</label>
          <textarea id="un-note" className="field" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={busy || note.trim().length < 3} onClick={() => act({ action: "note", note }, "הערת הבירור נשמרה")}>
            שמירת הערה
          </button>
        </div>
        <div className="border-t border-cream-200 pt-3 space-y-2">
          <p className="font-semibold">הכרעה ידנית (רק כשאי אפשר לאמת מול הספק)</p>
          <input aria-label="אסמכתה" className="field" placeholder="אסמכתה (חובה, לפחות 6 תווים)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {item.kind === "PAYMENT" && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || evidence.trim().length < 6} onClick={() => act({ action: "resolve", outcome: "FAILED", evidence, note }, "התשלום סומן כנכשל")}>
                לא חויב / נכשל
              </button>
            )}
            {item.kind === "REFUND" && (
              <>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || evidence.trim().length < 6} onClick={() => act({ action: "resolve", outcome: "SUCCEEDED", evidence, note }, "ההחזר סומן כמבוצע")}>
                  ההחזר בוצע
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || evidence.trim().length < 6} onClick={() => act({ action: "resolve", outcome: "FAILED", evidence, note }, "ההחזר סומן כלא בוצע")}>
                  ההחזר לא בוצע
                </button>
              </>
            )}
            {item.kind === "SHIFT_CHARGE" && (
              <>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act({ action: "resolve", outcome: "PAID", evidence, note }, "החיוב סומן כשולם")}>
                  חויב
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act({ action: "resolve", outcome: "NOT_CHARGED", evidence, note }, "החיוב סומן כלא חויב")}>
                  לא חויב
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" className="btn btn-secondary" onClick={onClose}>סגירה</button>
        </div>
      </div>
    </Dialog>
  );
}
