"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, EmptyState, Loading, SectionTitle } from "@/components/ui";
import { Dialog, ToneBadge } from "@/components/shifts/bits";
import { api, shekel, useSingleFlight } from "@/lib/payments/client";
import { DEBT_STATUS, Money, PAYMENT_STATUS, PURPOSE_LABEL, fmtDate, fmtDateTime } from "@/components/finance/bits";
import { DebtBookingDialog, DebtDialog, RefundDialog, type DebtView } from "@/components/finance/finance-actions";
import { SHIFT_STATUS_TEXT, WEEKDAY_NAMES, monthLabel, windowLabel } from "@/lib/shifts/labels";

interface Card {
  user: { id: string; name: string; email: string | null; phone: string | null; status: string; canBookShifts: boolean };
  blocked: boolean;
  payments: { id: string; purpose: string; status: string; amountAgorot: number; createdAt: string; paidAt: string | null }[];
  refunds: { id: string; paymentId: string; status: string; amountAgorot: number; reason: string | null; createdAt: string }[];
  debts: DebtView[];
  packages: { id: string; hours: number; pricePaidAgorot: number; minutesRemaining: number; minutesTotal: number; expiresAt: string; expired: boolean; cancelledAt: string | null }[];
  balance: { totalMinutes: number; credits: { id: string; minutesRemaining: number; expiresAt: string }[] };
  cancellationRequests: { id: string; packageId: string; status: string; reason: string | null; createdAt: string; decisionNote: string | null; refundAgorot: number }[];
  shifts: { id: string; room: string; weekday: number; windowId: string; status: string; suspensionReason: string | null; charges: { id: string; month: string; status: string; amountAgorot: number; failureCode: string | null }[] }[];
  audit: { id: string; action: string; adminName: string | null; outcome: string; reason: string | null; createdAt: string }[];
}

/** כרטיס כספי של לקוח (מנהל בלבד): תשלומים, חובות, יתרות, חבילות, החזרים, בקשות, משמרות וחסימה, עם פעולות לפי הרשאות */
export function CustomerFinance({ id }: { id: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [debt, setDebt] = useState<DebtView | null>(null);
  const [refund, setRefund] = useState<{ paymentId: string; max: number } | null>(null);
  const [booking, setBooking] = useState(false);
  const [blockDlg, setBlockDlg] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Card>(`/api/admin/finance/customers/${id}`);
    if (r.ok) setCard(r.data as Card);
    else setError(r.data.error ?? "שגיאה בטעינה");
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת הנתונים מהשרת בעת פתיחת העמוד
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!card) return <Loading />;
  const done = (text: string) => {
    setNotice({ tone: "success", text });
    void load();
  };
  const refundedOf = (paymentId: string) => card.refunds.filter((r) => r.paymentId === paymentId && r.status !== "FAILED").reduce((n, r) => n + r.amountAgorot, 0);

  return (
    <div className="space-y-8" data-testid="customer-finance">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <div className="card p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-display text-lg font-bold">{card.user.name}</p>
          <p className="text-stone-500">{card.user.email ?? card.user.phone}</p>
          <p className="mt-1">
            <ToneBadge tone={card.blocked ? "bad" : card.user.status === "APPROVED" ? "ok" : "pending"}>{card.blocked ? "חסום מהזמנות" : card.user.status === "APPROVED" ? "פעיל" : "ממתין לאישור"}</ToneBadge>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setBooking(true)} disabled={card.user.status !== "APPROVED"}>אישור הזמנה עם חוב</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setBlockDlg(true)} disabled={card.user.status === "PENDING"}>
            {card.blocked ? "שחרור חסימה" : "חסימה מהזמנות"}
          </button>
        </div>
      </div>

      <section>
        <SectionTitle hint="חוב פתוח אינו חוסם הזמנות; רק חסימה מפורשת">חובות</SectionTitle>
        {card.debts.length === 0 ? (
          <EmptyState icon="list">אין חובות.</EmptyState>
        ) : (
          <div className="card overflow-x-auto mt-3">
            <table className="table-base">
              <thead>
                <tr><th>נוצר</th><th>סכום</th><th>שולם</th><th>נמחל</th><th>יתרה</th><th>סטטוס</th></tr>
              </thead>
              <tbody>
                {card.debts.map((d) => {
                  const st = DEBT_STATUS[d.status] ?? { label: d.status, tone: "neutral" as const };
                  return (
                    <tr key={d.id} className="cursor-pointer hover:bg-cream-50" onClick={() => setDebt(d)}>
                      <td className="text-xs">{fmtDate(d.createdAt)}</td>
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
      </section>

      <section>
        <SectionTitle hint="כסף שנגבה בפועל מהלקוח">תשלומים</SectionTitle>
        {card.payments.length === 0 ? (
          <EmptyState icon="card">אין תשלומים.</EmptyState>
        ) : (
          <div className="card overflow-x-auto mt-3">
            <table className="table-base">
              <thead><tr><th>תאריך</th><th>מטרה</th><th>סכום</th><th>הוחזר</th><th>סטטוס</th><th /></tr></thead>
              <tbody>
                {card.payments.map((p) => {
                  const st = PAYMENT_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
                  const left = p.amountAgorot - refundedOf(p.id);
                  const canRefund = p.status === "SUCCEEDED" && (p.purpose === "BOOKING" || p.purpose === "DEBT") && left > 0;
                  return (
                    <tr key={p.id}>
                      <td className="text-xs tabular-nums">{fmtDateTime(p.paidAt ?? p.createdAt)}</td>
                      <td>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</td>
                      <td><Money agorot={p.amountAgorot} /></td>
                      <td><Money agorot={refundedOf(p.id)} /></td>
                      <td><ToneBadge tone={st.tone}>{st.label}</ToneBadge></td>
                      <td>{canRefund && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRefund({ paymentId: p.id, max: left })}>החזר</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle hint="יתרת הדקות הזמינה כעת, כפי שחושבה בשרת">יתרות, חבילות וזיכויים</SectionTitle>
        <p className="text-sm mt-2">יתרה זמינה: <strong>{card.balance.totalMinutes} דקות</strong></p>
        {card.packages.length === 0 ? (
          <p className="text-sm text-stone-500 mt-2">אין חבילות.</p>
        ) : (
          <ul className="card divide-y divide-cream-100 mt-3 text-sm">
            {card.packages.map((p) => (
              <li key={p.id} className="p-3 flex flex-wrap items-center justify-between gap-2">
                <span>חבילת {p.hours} שעות · נותרו {p.minutesRemaining}/{p.minutesTotal} דק׳ · עד {fmtDate(p.expiresAt)}</span>
                <span className="flex items-center gap-2">
                  <Money agorot={p.pricePaidAgorot} />
                  <ToneBadge tone={p.cancelledAt ? "neutral" : p.expired ? "neutral" : p.minutesRemaining > 0 ? "ok" : "pending"}>{p.cancelledAt ? "בוטלה" : p.expired ? "פגה" : p.minutesRemaining > 0 ? "פעילה" : "נוצלה"}</ToneBadge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {card.balance.credits.length > 0 && (
          <ul className="text-sm text-stone-600 mt-2 list-disc pr-5">
            {card.balance.credits.map((c) => <li key={c.id}>זיכוי: {c.minutesRemaining} דק׳ עד {fmtDate(c.expiresAt)}</li>)}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>החזרים ובקשות ביטול חבילה</SectionTitle>
        {card.refunds.length === 0 && card.cancellationRequests.length === 0 ? (
          <p className="text-sm text-stone-500 mt-2">אין.</p>
        ) : (
          <ul className="card divide-y divide-cream-100 mt-3 text-sm">
            {card.refunds.map((r) => (
              <li key={r.id} className="p-3 flex justify-between gap-2">
                <span>החזר · {fmtDate(r.createdAt)}{r.reason ? ` · ${r.reason}` : ""}</span>
                <span className="flex items-center gap-2"><Money agorot={r.amountAgorot} /><ToneBadge tone={r.status === "SUCCEEDED" ? "ok" : r.status === "FAILED" ? "bad" : "pending"}>{r.status === "SUCCEEDED" ? "בוצע" : r.status === "FAILED" ? "נכשל" : "ממתין"}</ToneBadge></span>
              </li>
            ))}
            {card.cancellationRequests.map((r) => (
              <li key={r.id} className="p-3 flex justify-between gap-2">
                <span>בקשת ביטול חבילה · {fmtDate(r.createdAt)}{r.decisionNote ? ` · ${r.decisionNote}` : ""}</span>
                <ToneBadge tone={r.status === "APPROVED" ? "ok" : r.status === "REJECTED" ? "bad" : "pending"}>{r.status === "APPROVED" ? "אושרה" : r.status === "REJECTED" ? "נדחתה" : "ממתינה"}</ToneBadge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {card.shifts.length > 0 && (
        <section>
          <SectionTitle hint="חיובי משמרת מיוצגים בחיוב המשמרת, לא ברשומת חוב">משמרות וחיובים חודשיים</SectionTitle>
          <ul className="space-y-3 mt-3">
            {card.shifts.map((s) => (
              <li key={s.id} className="card p-4 text-sm space-y-1">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span>{s.room} · יום {WEEKDAY_NAMES[s.weekday]} · {windowLabel(s.windowId)}</span>
                  <span className="flex items-center gap-2">
                    <ToneBadge tone={SHIFT_STATUS_TEXT[s.status]?.tone ?? "neutral"}>{SHIFT_STATUS_TEXT[s.status]?.label ?? s.status}</ToneBadge>
                    <Link className="text-brand-700 underline" href={`/admin/shifts?open=${s.id}`}>פרטי משמרת</Link>
                  </span>
                </p>
                <ul className="text-xs text-stone-600">
                  {s.charges.map((c) => <li key={c.id}>{monthLabel(c.month)}: {shekel(c.amountAgorot)} · {c.status}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionTitle>פעולות מנהל על הלקוח</SectionTitle>
        {card.audit.length === 0 ? (
          <p className="text-sm text-stone-500 mt-2">אין.</p>
        ) : (
          <ul className="card divide-y divide-cream-100 mt-3 text-xs">
            {card.audit.map((a) => (
              <li key={a.id} className="p-3 flex flex-wrap justify-between gap-2">
                <span>{a.action} · {a.adminName ?? "מערכת"}{a.reason ? ` · ${a.reason}` : ""}</span>
                <span className="text-stone-400 tabular-nums">{fmtDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {debt && <DebtDialog debt={debt} onClose={() => setDebt(null)} onDone={(t) => { setDebt(null); done(t); }} onError={(t) => setNotice({ tone: "error", text: t })} />}
      {refund && <RefundDialog paymentId={refund.paymentId} maxAgorot={refund.max} onClose={() => setRefund(null)} onDone={(t) => { setRefund(null); done(t); }} onError={(t) => setNotice({ tone: "error", text: t })} />}
      {booking && <DebtBookingDialog presetUser={{ id: card.user.id, name: card.user.name }} onClose={() => setBooking(false)} onDone={(t) => { setBooking(false); done(t); }} />}
      {blockDlg && <BlockDialog blocked={card.blocked} userId={card.user.id} onClose={() => setBlockDlg(false)} onDone={(t) => { setBlockDlg(false); done(t); }} onError={(t) => setNotice({ tone: "error", text: t })} />}
    </div>
  );
}

function BlockDialog({ blocked, userId, onClose, onDone, onError }: { blocked: boolean; userId: string; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [reason, setReason] = useState("");
  const { busy, run } = useSingleFlight();
  async function submit() {
    await run(async () => {
      const r = await api(`/api/admin/finance/customers/${userId}/block`, { body: { blocked: !blocked, reason } });
      if (r.ok) onDone(blocked ? "החסימה שוחררה" : "הלקוח נחסם מהזמנות חדשות");
      else onError(r.data.error ?? "הפעולה נכשלה");
    });
  }
  return (
    <Dialog title={blocked ? "שחרור חסימה" : "חסימה מהזמנות"} labelId="blk" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>{blocked ? "הלקוח יוכל להזמין שוב." : "הלקוח לא יוכל להזמין חדרים או משמרות חדשים. הזמנות קיימות אינן מבוטלות."}</p>
        <div>
          <label className="field-label" htmlFor="blk-reason">סיבה (חובה)</label>
          <textarea id="blk-reason" className="field" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>חזרה</button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={submit}>אישור</button>
        </div>
      </div>
    </Dialog>
  );
}
