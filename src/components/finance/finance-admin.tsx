"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, EmptyState, Loading, SectionTitle, StatCard } from "@/components/ui";
import { ToneBadge } from "@/components/shifts/bits";
import { api } from "@/lib/payments/client";
import { AUDIT_ACTION, LEDGER_TYPE, Money, PAYMENT_STATUS, PURPOSE_LABEL, fmtDate, fmtDateTime } from "@/components/finance/bits";
import { DebtsTab, PackageRequestsTab, RefundsTab, UnknownTab } from "@/components/finance/finance-actions";
import { monthLabel, SHIFT_STATUS_TEXT, windowLabel, WEEKDAY_NAMES } from "@/lib/shifts/labels";

export interface Overview {
  environmentNote: string;
  collected: { grossAgorot: number; count: number; refundedAgorot: number; netAgorot: number };
  failedPayments: { count: number; agorot: number };
  unknownPayments: { count: number; agorot: number; stuckPayments: number; unknownShiftCharges: number };
  debts: { openCount: number; openAgorot: number; inReviewCount: number; inReviewAgorot: number; waivedAgorot: number; waivedCount: number; paidDownAgorot: number; paidDownCount: number };
  refunds: { doneCount: number; doneAgorot: number; pendingCount: number; pendingAgorot: number; failedCount: number; failedAgorot: number; exceptionsAwaitingCount: number; exceptionsAwaitingAgorot: number };
  packageCancellationRequestsPending: number;
  shifts: { failedChargesCount: number; failedChargesAgorot: number; pendingChargesCount: number; pendingChargesAgorot: number; unknownChargesCount: number; unknownChargesAgorot: number; graceShifts: number; suspendedShifts: number } | null;
  outstandingNotCollectedAgorot: number;
  outstandingBreakdown: { bookingDebtsAgorot: number; shiftArrearsAgorot: number };
  unusualAdminActions: { action: string; count: number }[];
}

type Tab = "overview" | "debts" | "refunds" | "packages" | "unknown" | "shifts" | "audit";

export function FinanceAdmin() {
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const tell = useCallback((tone: "success" | "error", text: string) => setNotice({ tone, text }), []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "תמונת מצב" },
    { id: "debts", label: "חובות" },
    { id: "refunds", label: "החזרים" },
    { id: "packages", label: "ביטול חבילות" },
    { id: "unknown", label: "תור בירור" },
    { id: "shifts", label: "משמרות" },
    { id: "audit", label: "יומן ביקורת" },
  ];

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="ניהול כספי" className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setNotice(null);
            }}
            className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap ${tab === t.id ? "bg-brand-600 text-white" : "bg-cream-100 text-stone-600"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {tab === "overview" && <OverviewTab version={version} />}
      {tab === "debts" && <DebtsTab version={version} onChanged={refresh} tell={tell} />}
      {tab === "refunds" && <RefundsTab version={version} onChanged={refresh} tell={tell} />}
      {tab === "packages" && <PackageRequestsTab version={version} onChanged={refresh} tell={tell} />}
      {tab === "unknown" && <UnknownTab version={version} onChanged={refresh} tell={tell} />}
      {tab === "shifts" && <ShiftsFinanceTab version={version} />}
      {tab === "audit" && <AuditTab version={version} />}
    </div>
  );
}

// ───────────────────────────── תמונת מצב + ספר תנועות ─────────────────────────────

function OverviewTab({ version }: { version: number }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("ALL");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [o, setO] = useState<Overview | null>(null);
  const [rows, setRows] = useState<{ key: string; at: string; type: string; label: string; user: { id: string; name: string }; amountAgorot: number; status: string; ref: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const range = new URLSearchParams();
    if (from) range.set("from", from);
    if (to) range.set("to", to);
    const ledger = new URLSearchParams(range);
    ledger.set("type", type);
    if (status) ledger.set("status", status);
    if (q) ledger.set("q", q);
    const t = setTimeout(async () => {
      const [a, b] = await Promise.all([api<Overview>(`/api/admin/finance/overview?${range}`), api<{ rows: NonNullable<typeof rows> }>(`/api/admin/finance/ledger?${ledger}`)]);
      if (cancelled) return;
      if (a.ok && b.ok) {
        setO(a.data as Overview);
        setRows((b.data as { rows: NonNullable<typeof rows> }).rows);
        setError(null);
      } else setError(a.data.error ?? b.data.error ?? "שגיאה בטעינה");
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [from, to, type, status, q, version]);

  return (
    <section className="space-y-6">
      <div className="card p-4 grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="field-label" htmlFor="f-from">מתאריך</label>
          <input id="f-from" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="f-to">עד תאריך</label>
          <input id="f-to" type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="f-type">סוג פעולה</label>
          <select id="f-type" className="field" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="ALL">הכול</option>
            <option value="PAYMENT">תשלומים</option>
            <option value="REFUND">החזרים</option>
            <option value="DEBT_SETTLEMENT">הסדרות וויתורים</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="f-status">סטטוס</label>
          <select id="f-status" className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">הכול</option>
            <option value="SUCCEEDED">הצליח / בוצע</option>
            <option value="PENDING">ממתין</option>
            <option value="FAILED">נכשל</option>
            <option value="CANCELLED">בוטל</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="f-q">לקוח</label>
          <input id="f-q" className="field" placeholder="שם, אימייל או טלפון" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!o ? (
        <Loading />
      ) : (
        <>
          <p className="text-xs text-stone-500">{o.environmentNote}. הסכומים מוצגים בשקלים ובאגורות מדויקות. הכנסות אינן מחושבות מהזמנות, רק מתשלומים שהספק אישר.</p>
          <div>
            <SectionTitle hint="כסף שהספק אישר בפועל, ופחות מזה החזרים שבוצעו">נגבה בפועל</SectionTitle>
            <div className="grid sm:grid-cols-3 gap-4 mt-3" data-testid="collected">
              <StatCard label={`נגבה (ברוטו) · ${o.collected.count} תשלומים`} value={<Money agorot={o.collected.grossAgorot} strong />} icon="card" />
              <StatCard label={`הוחזר בפועל · ${o.refunds.doneCount}`} value={<Money agorot={o.collected.refundedAgorot} strong />} icon="chart" tone="gold" />
              <StatCard label="נטו שנגבה" value={<Money agorot={o.collected.netAgorot} strong />} icon="chart" />
            </div>
          </div>
          <div>
            <SectionTitle hint="התחייבויות שטרם נגבו. אינן נכללות בכסף שנגבה">חוב שטרם נגבה</SectionTitle>
            <div className="grid sm:grid-cols-3 gap-4 mt-3" data-testid="outstanding">
              <StatCard label={`חובות הזמנות פתוחים · ${o.debts.openCount}`} value={<Money agorot={o.debts.openAgorot} strong />} icon="list" tone="gold" />
              <StatCard label={`חובות בבירור · ${o.debts.inReviewCount}`} value={<Money agorot={o.debts.inReviewAgorot} strong />} icon="list" tone="gold" />
              {o.shifts && <StatCard label={`חיובי משמרת שלא נגבו · ${o.shifts.failedChargesCount + o.shifts.pendingChargesCount}`} value={<Money agorot={o.outstandingBreakdown.shiftArrearsAgorot} strong />} icon="clock" tone="gold" />}
            </div>
            <p className="text-sm text-stone-600 mt-2">
              סך הכול שטרם נגבה (ללא ספירה כפולה): <Money agorot={o.outstandingNotCollectedAgorot} strong />
            </p>
          </div>
          <div>
            <SectionTitle hint="החזרים שממתינים לטיפול, חריגים ובקשות">ממתין לטיפול</SectionTitle>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-3">
              <StatCard label={`החזרים ממתינים · ${o.refunds.pendingCount}`} value={<Money agorot={o.refunds.pendingAgorot} strong />} icon="card" tone="gold" />
              <StatCard label={`חריגי החזר להכרעה · ${o.refunds.exceptionsAwaitingCount}`} value={<Money agorot={o.refunds.exceptionsAwaitingAgorot} strong />} icon="card" tone="gold" />
              <StatCard label="בקשות ביטול חבילה" value={o.packageCancellationRequestsPending} icon="list" tone="gold" />
              <StatCard label={`החזרים שנכשלו · ${o.refunds.failedCount}`} value={<Money agorot={o.refunds.failedAgorot} strong />} icon="chart" tone="gold" />
            </div>
          </div>
          <div>
            <SectionTitle hint="תשלומים שנכשלו, תקועים או במצב לא ידוע, ומחילות">חריגים</SectionTitle>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-3">
              <StatCard label={`תשלומים שנכשלו · ${o.failedPayments.count}`} value={<Money agorot={o.failedPayments.agorot} strong />} icon="chart" tone="gold" />
              <StatCard label={`לא ידוע / תקוע · ${o.unknownPayments.count}`} value={<Money agorot={o.unknownPayments.agorot} strong />} icon="chart" tone="gold" />
              <StatCard label={`נמחל (לא הכנסה) · ${o.debts.waivedCount}`} value={<Money agorot={o.debts.waivedAgorot} strong />} icon="list" />
              <StatCard label={`הוסדר בתשלום חיצוני · ${o.debts.paidDownCount}`} value={<Money agorot={o.debts.paidDownAgorot} strong />} icon="list" />
            </div>
            {o.shifts && (
              <p className="text-sm text-stone-600 mt-3">
                משמרות: {o.shifts.graceShifts} בתקופת חסד · {o.shifts.suspendedShifts} מושעות · {o.shifts.unknownChargesCount} חיובים לא ידועים.
              </p>
            )}
            {o.unusualAdminActions.length > 0 && (
              <p className="text-sm text-stone-600 mt-2">
                פעולות מנהל חריגות בטווח: {o.unusualAdminActions.map((a) => `${AUDIT_ACTION[a.action] ?? a.action} (${a.count})`).join(" · ")}
              </p>
            )}
          </div>
        </>
      )}

      <div>
        <SectionTitle hint="תשלומים, החזרים והסדרות לפי המסננים למעלה">ספר תנועות</SectionTitle>
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon="list">אין תנועות תואמות.</EmptyState>
        ) : (
          <div className="card overflow-x-auto mt-3">
            <table className="table-base" data-testid="ledger">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>סוג</th>
                  <th>לקוח</th>
                  <th>סכום</th>
                  <th>סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = PAYMENT_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                  return (
                    <tr key={r.key}>
                      <td className="text-xs tabular-nums">{fmtDateTime(r.at)}</td>
                      <td>
                        {LEDGER_TYPE[r.type]} <span className="text-xs text-stone-400">{PURPOSE_LABEL[r.label] ?? r.label}</span>
                      </td>
                      <td>
                        <Link className="text-brand-700 underline" href={`/admin/finance/customers/${r.user.id}`}>
                          {r.user.name}
                        </Link>
                      </td>
                      <td>
                        <Money agorot={r.amountAgorot} />
                      </td>
                      <td>
                        <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ───────────────────────────── משמרות ─────────────────────────────

interface ShiftFinance {
  enabled: boolean;
  charges: { id: string; shiftId: string; status: string; month: string; amountAgorot: number; failureCode: string | null; graceUntil: string | null; user: { id: string; name: string }; room: string; shiftStatus: string }[];
  graceShifts: { id: string; user: { id: string; name: string }; room: string; weekday: number; windowId: string; owedAgorot: number; graceUntil: string | null }[];
  suspendedShifts: { id: string; user: { id: string; name: string }; room: string; weekday: number; windowId: string; reason: string | null; owedAgorot: number }[];
}

function ShiftsFinanceTab({ version }: { version: number }) {
  const [data, setData] = useState<ShiftFinance | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<ShiftFinance>("/api/admin/finance/shifts").then((r) => {
      if (!cancelled && r.ok) setData(r.data as ShiftFinance);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);
  if (!data) return <Loading />;
  if (!data.enabled) return <EmptyState icon="clock">מודול המשמרות סגור בסביבה זו.</EmptyState>;
  const link = (id: string) => `/admin/shifts?open=${id}`;
  return (
    <section className="space-y-6">
      <p className="text-xs text-stone-500">חוב משמרת מיוצג בחיוב המשמרת (ShiftCharge) ולא ברשומת חוב, ולכן אינו נספר פעמיים. הטיפול נעשה במסך המשמרות.</p>
      <div>
        <SectionTitle hint="חיובים שלא נגבו">חיובי משמרת פתוחים</SectionTitle>
        {data.charges.length === 0 ? (
          <EmptyState icon="clock">אין חיובי משמרת פתוחים.</EmptyState>
        ) : (
          <div className="card overflow-x-auto mt-3">
            <table className="table-base" data-testid="shift-charges">
              <thead>
                <tr>
                  <th>לקוח</th>
                  <th>חודש</th>
                  <th>סכום</th>
                  <th>מצב</th>
                  <th>משמרת</th>
                </tr>
              </thead>
              <tbody>
                {data.charges.map((c) => (
                  <tr key={c.id}>
                    <td>{c.user.name}</td>
                    <td>{monthLabel(c.month)}</td>
                    <td>
                      <Money agorot={c.amountAgorot} />
                    </td>
                    <td>
                      <ToneBadge tone={c.status === "FAILED" ? "bad" : "pending"}>{c.status === "FAILED" ? "נכשל" : c.status === "UNKNOWN" ? "לא ידוע" : "ממתין"}</ToneBadge>
                      {c.graceUntil && c.status === "FAILED" && <span className="block text-xs text-stone-500">חסד עד {fmtDate(c.graceUntil)}</span>}
                    </td>
                    <td>
                      <Link className="text-brand-700 underline" href={link(c.shiftId)}>
                        {SHIFT_STATUS_TEXT[c.shiftStatus]?.label ?? c.shiftStatus} · לפרטי המשמרת
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ShiftList title="משמרות בתקופת חסד" rows={data.graceShifts.map((s) => ({ ...s, note: s.graceUntil ? `עד ${fmtDate(s.graceUntil)}` : "" }))} link={link} />
      <ShiftList title="משמרות מושעות" rows={data.suspendedShifts.map((s) => ({ ...s, note: s.reason ?? "" }))} link={link} />
    </section>
  );
}

function ShiftList({ title, rows, link }: { title: string; rows: { id: string; user: { name: string }; room: string; weekday: number; windowId: string; owedAgorot: number; note: string }[]; link: (id: string) => string }) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500 mt-2">אין.</p>
      ) : (
        <ul className="card divide-y divide-cream-100 mt-3">
          {rows.map((s) => (
            <li key={s.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <strong>{s.user.name}</strong> · {s.room} · {WEEKDAY_NAMES[s.weekday]} · {windowLabel(s.windowId)}
                {s.note && <span className="block text-xs text-stone-500">{s.note}</span>}
              </span>
              <span className="flex items-center gap-3">
                <Money agorot={s.owedAgorot} />
                <Link className="btn btn-secondary btn-sm" href={link(s.id)}>
                  פרטי משמרת
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── יומן ביקורת ─────────────────────────────

interface AuditRow {
  id: string;
  action: string;
  adminName: string | null;
  userId: string | null;
  userName: string | null;
  entityType: string;
  entityId: string | null;
  outcome: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

function AuditTab({ version }: { version: number }) {
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const p = new URLSearchParams();
    if (action) p.set("action", action);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    api<{ entries: AuditRow[] }>(`/api/admin/finance/audit?${p}`).then((r) => {
      if (!cancelled && r.ok) setRows((r.data as { entries: AuditRow[] }).entries);
    });
    return () => {
      cancelled = true;
    };
  }, [action, from, to, version]);
  return (
    <section className="space-y-4">
      <p className="text-xs text-stone-500">היומן לקריאה בלבד: אי אפשר לערוך או למחוק רשומות.</p>
      <div className="card p-4 grid sm:grid-cols-3 gap-3">
        <select aria-label="סוג פעולה" className="field" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">כל הפעולות</option>
          {Object.entries(AUDIT_ACTION).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input aria-label="מתאריך" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input aria-label="עד תאריך" type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon="list">אין רשומות.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base" data-testid="audit-table">
            <thead>
              <tr>
                <th>זמן</th>
                <th>פעולה</th>
                <th>מנהל</th>
                <th>לקוח</th>
                <th>תוצאה</th>
                <th>סיבה</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</td>
                  <td>{AUDIT_ACTION[r.action] ?? r.action}</td>
                  <td>{r.adminName ?? "—"}</td>
                  <td>
                    {r.userId ? (
                      <Link className="text-brand-700 underline" href={`/admin/finance/customers/${r.userId}`}>
                        {r.userName ?? "לקוח"}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <ToneBadge tone={r.outcome === "ok" ? "ok" : r.outcome === "unknown" ? "pending" : "bad"}>{r.outcome}</ToneBadge>
                  </td>
                  <td className="text-xs max-w-xs">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
