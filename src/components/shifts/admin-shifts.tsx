"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, EmptyState, Loading, SectionTitle } from "@/components/ui";
import { Dialog, ToneBadge, jerusalemTime } from "@/components/shifts/bits";
import { api, shekel, useSingleFlight } from "@/lib/payments/client";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import {
  CHARGE_STATUS_TEXT,
  OCCURRENCE_STATUS_TEXT,
  REQUEST_KIND_TEXT,
  SHIFT_STATUS_TEXT,
  WEEKDAY_NAMES,
  dateLabel,
  failureText,
  monthLabel,
  suspensionText,
  windowLabel,
} from "@/lib/shifts/labels";
import type { AdminShiftDetail, AdminShiftRow, ShiftRequestView } from "@/lib/shifts/views";

type Person = { id: string; name: string; email: string | null; phone: string | null };
type PendingRequest = ShiftRequestView & {
  user: Person;
  shift: { id: string; room: { key: string; name: string }; weekday: number; windowId: string; startDate: string; endDate: string; status: string };
};
type EligibilityRow = Person & { status: string; canBookShifts: boolean };
type CronRunRow = { id: string; period: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; summary: unknown };
interface Overview {
  requests: PendingRequest[];
  eligibility: EligibilityRow[];
  runs: CronRunRow[];
}

type Tab = "shifts" | "requests" | "eligibility" | "billing";

export function AdminShifts() {
  const [tab, setTab] = useState<Tab>("shifts");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [eligQuery, setEligQuery] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [version, setVersion] = useState(0);

  const loadOverview = useCallback(async () => {
    const res = await api<Overview>(`/api/admin/shifts/overview${eligQuery ? `?q=${encodeURIComponent(eligQuery)}` : ""}`);
    if (res.ok) setOverview(res.data as Overview);
    else setNotice({ tone: "error", text: res.data.error ?? "שגיאה בטעינה" });
  }, [eligQuery]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת הנתונים מהשרת
    loadOverview();
  }, [loadOverview, version]);

  const refresh = () => setVersion((v) => v + 1);
  const tell = (tone: "success" | "error", text: string) => setNotice({ tone, text });

  const tabs: { id: Tab; label: string }[] = [
    { id: "shifts", label: "משמרות" },
    { id: "requests", label: `בקשות${overview && overview.requests.length ? ` (${overview.requests.length})` : ""}` },
    { id: "eligibility", label: "זכאות" },
    { id: "billing", label: "חיוב חודשי" },
  ];

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="ניהול משמרות" className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap ${tab === t.id ? "bg-brand-600 text-white" : "bg-cream-100 text-stone-600"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!overview ? (
        <Loading />
      ) : (
        <>
          {tab === "shifts" && <ShiftsTab version={version} onChanged={refresh} tell={tell} />}
          {tab === "requests" && <RequestsTab requests={overview.requests} onChanged={refresh} tell={tell} />}
          {tab === "eligibility" && <EligibilityTab rows={overview.eligibility} query={eligQuery} setQuery={setEligQuery} onChanged={refresh} tell={tell} />}
          {tab === "billing" && <BillingTab runs={overview.runs} onChanged={refresh} tell={tell} />}
        </>
      )}
    </div>
  );
}

type Tell = (tone: "success" | "error", text: string) => void;

// ───────────────────────────── משמרות ─────────────────────────────

function ShiftsTab({ version, onChanged, tell }: { version: number; onChanged: () => void; tell: Tell }) {
  const searchParams = useSearchParams();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [roomKey, setRoomKey] = useState("");
  const [weekday, setWeekday] = useState("");
  const [rows, setRows] = useState<AdminShiftRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(searchParams.get("open"));

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (roomKey) params.set("roomKey", roomKey);
    if (weekday) params.set("weekday", weekday);
    const t = setTimeout(async () => {
      const res = await api<{ shifts: AdminShiftRow[] }>(`/api/admin/shifts?${params}`);
      if (!cancelled && res.ok) setRows((res.data as { shifts: AdminShiftRow[] }).shifts);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, status, roomKey, weekday, version]);

  return (
    <section className="space-y-4">
      <div className="card p-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <input aria-label="חיפוש לקוח" className="field" placeholder="שם, אימייל או טלפון" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="סטטוס" className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">כל הסטטוסים</option>
          {Object.entries(SHIFT_STATUS_TEXT).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <select aria-label="חדר" className="field" value={roomKey} onChange={(e) => setRoomKey(e.target.value)}>
          <option value="">כל החדרים</option>
          {ROOM_KEYS.map((k) => (
            <option key={k} value={k}>{ROOM_LABELS[k]}</option>
          ))}
        </select>
        <select aria-label="יום" className="field" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
          <option value="">כל הימים</option>
          {WEEKDAY_NAMES.map((n, i) => (
            <option key={n} value={i}>{n}</option>
          ))}
        </select>
      </div>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon="calendar">אין משמרות תואמות.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base" data-testid="admin-shifts-table">
            <thead>
              <tr>
                <th>לקוח</th>
                <th>חדר</th>
                <th>יום ומשבצת</th>
                <th>תקופה</th>
                <th>מצב</th>
                <th>דורש טיפול</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = SHIFT_STATUS_TEXT[r.status] ?? { label: r.status, tone: "neutral" as const };
                return (
                  <tr key={r.id} className="cursor-pointer hover:bg-cream-50" onClick={() => setOpenId(r.id)}>
                    <td>
                      <button type="button" className="font-semibold text-brand-700 underline" onClick={() => setOpenId(r.id)}>
                        {r.user.name}
                      </button>
                      <span className="block text-xs text-stone-500">{r.user.email ?? r.user.phone}</span>
                    </td>
                    <td>{r.room.name}</td>
                    <td>
                      {WEEKDAY_NAMES[r.weekday]} · {windowLabel(r.windowId)}
                    </td>
                    <td className="tabular-nums text-xs">
                      {dateLabel(r.startDate)} – {dateLabel(r.endDate)}
                    </td>
                    <td>
                      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
                    </td>
                    <td className="text-xs space-x-1 space-x-reverse">
                      {r.unpaidCharges > 0 && <ToneBadge tone="bad">{r.unpaidCharges} חיובים לא שולמו</ToneBadge>}
                      {r.unknownCharges > 0 && <ToneBadge tone="pending">{r.unknownCharges} בבירור</ToneBadge>}
                      {r.hasOpenRequest && <ToneBadge tone="pending">בקשה פתוחה</ToneBadge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ShiftDetailDialog id={openId} version={version} onClose={() => setOpenId(null)} onChanged={onChanged} tell={tell} />}
    </section>
  );
}

function ShiftDetailDialog({ id, version, onClose, onChanged, tell }: { id: string; version: number; onClose: () => void; onChanged: () => void; tell: Tell }) {
  const [shift, setShift] = useState<AdminShiftDetail | null>(null);
  const [reason, setReason] = useState("");
  const { busy, run } = useSingleFlight();

  useEffect(() => {
    let cancelled = false;
    api<AdminShiftDetail>(`/api/admin/shifts/${id}`).then((res) => {
      if (!cancelled && res.ok) setShift(res.data as AdminShiftDetail);
    });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  async function act(url: string, body: unknown, success: string) {
    await run(async () => {
      const res = await api<Record<string, unknown>>(url, { body });
      if (res.ok) {
        tell("success", success);
        onChanged();
      } else tell("error", res.data.error ?? "הפעולה נכשלה");
    });
  }

  return (
    <Dialog title="פרטי משמרת" labelId="shift-detail" onClose={onClose}>
      {!shift ? (
        <Loading />
      ) : (
        <div className="space-y-4 text-sm">
          <p>
            <strong>{shift.user.name}</strong> · {shift.room.name} · יום {WEEKDAY_NAMES[shift.weekday]} · {windowLabel(shift.windowId)}
            <span className="block text-stone-500">
              {dateLabel(shift.startDate)} – {dateLabel(shift.endDate)} · {shekel(shift.occurrencePriceAgorot)} למופע · {SHIFT_STATUS_TEXT[shift.status]?.label ?? shift.status}
            </span>
          </p>
          {shift.status === "SUSPENDED" && <Alert tone="error">מושעית: {suspensionText(shift.suspensionReason)}</Alert>}

          <div>
            <h3 className="font-semibold mb-1">חיובים</h3>
            {shift.charges.length === 0 ? (
              <p className="text-stone-500">אין חיובים.</p>
            ) : (
              <ul className="divide-y divide-cream-100">
                {shift.charges.map((c) => {
                  const cs = CHARGE_STATUS_TEXT[c.status] ?? { label: c.status, tone: "neutral" as const };
                  return (
                    <li key={c.id} className="py-2 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {monthLabel(c.month)} · {c.occurrenceCount} מופעים · <strong>{shekel(c.amountAgorot)}</strong> · ניסיון {c.attempt}
                        </span>
                        <ToneBadge tone={cs.tone}>{cs.label}</ToneBadge>
                      </div>
                      {c.failureCode && <p className="text-xs text-red-600">סיבה: {failureText(c.failureCode)}</p>}
                      {c.graceUntil && c.status === "FAILED" && <p className="text-xs text-stone-500">תקופת חסד עד {dateLabel(c.graceUntil.slice(0, 10))}</p>}
                      {c.refundedAgorot > 0 && <p className="text-xs text-brand-700">הוחזרו {shekel(c.refundedAgorot)}</p>}
                      {c.note && <p className="text-xs text-stone-500">{c.note}</p>}
                      <div className="flex flex-wrap gap-2">
                        {c.status === "FAILED" && (
                          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(`/api/admin/shifts/charges/${c.id}`, { action: "retry" }, "החיוב נוסה שוב")}>
                            ניסיון חיוב חוזר
                          </button>
                        )}
                        {c.status === "UNKNOWN" && (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={busy}
                              onClick={() => act(`/api/admin/shifts/charges/${c.id}`, { action: "resolve-paid", note: reason || undefined }, "החיוב סומן כשולם")}
                            >
                              אומת אצל הספק: חויב
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={busy}
                              onClick={() => act(`/api/admin/shifts/charges/${c.id}`, { action: "resolve-not-charged", note: reason || undefined }, "החיוב סומן כלא חויב")}
                            >
                              אומת אצל הספק: לא חויב
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <details>
            <summary className="cursor-pointer font-semibold">מופעים ({shift.occurrences.length})</summary>
            <ul className="mt-2 divide-y divide-cream-100 tabular-nums text-xs">
              {shift.occurrences.map((o) => (
                <li key={o.id} className="py-1 flex justify-between gap-2">
                  <span>
                    {dateLabel(o.date)} · {jerusalemTime(o.startTime)}–{jerusalemTime(o.endTime)}
                  </span>
                  <span>
                    {OCCURRENCE_STATUS_TEXT[o.status] ?? o.status} · {shekel(o.priceAgorot)}
                    {o.refundedAgorot > 0 && ` · הוחזר ${shekel(o.refundedAgorot)}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>

          {(shift.status === "ACTIVE" || shift.status === "SUSPENDED") && (
            <div className="space-y-2 border-t border-cream-200 pt-3">
              <label className="field-label" htmlFor="sd-note">הערה / סיבה (לא חובה)</label>
              <input id="sd-note" className="field" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                {shift.status === "ACTIVE" && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(`/api/admin/shifts/${id}/suspend`, { reason }, "המשמרת הושעתה")}>
                    השעיה
                  </button>
                )}
                {shift.status === "SUSPENDED" && (
                  <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(`/api/admin/shifts/${id}/resume`, { note: reason }, "המשמרת חודשה")}>
                      חידוש (חובות פתוחים נשארים)
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(`/api/admin/shifts/${id}/resume`, { waiveUnpaid: true, note: reason }, "המשמרת חודשה והחובות נמחלו")}>
                      חידוש עם מחילת חובות
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              סגירה
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────────── בקשות ─────────────────────────────

function RequestsTab({ requests, onChanged, tell }: { requests: PendingRequest[]; onChanged: () => void; tell: Tell }) {
  const [active, setActive] = useState<PendingRequest | null>(null);
  return (
    <section className="space-y-4">
      <SectionTitle hint="שינוי או ביטול נכנסים לתוקף רק לאחר אישור">בקשות ממתינות</SectionTitle>
      {requests.length === 0 ? (
        <EmptyState icon="list">אין בקשות ממתינות.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => (
            <li key={r.id} className="card p-4 flex flex-wrap items-center justify-between gap-3" data-testid="pending-request">
              <div className="text-sm">
                <p className="font-semibold">
                  {r.user.name} · {REQUEST_KIND_TEXT[r.kind]}
                </p>
                <p className="text-stone-500">
                  {r.shift.room.name} · {WEEKDAY_NAMES[r.shift.weekday]} · {windowLabel(r.shift.windowId)}
                </p>
                {r.kind === "CHANGE" && (
                  <p className="text-stone-600">
                    מבוקש: {r.proposedRoomKey ? ROOM_LABELS[r.proposedRoomKey as keyof typeof ROOM_LABELS] ?? r.proposedRoomKey : "אותו חדר"} ·{" "}
                    {r.proposedWeekday !== null ? WEEKDAY_NAMES[r.proposedWeekday] : "אותו יום"} · {r.proposedWindowId ? windowLabel(r.proposedWindowId) : "אותה משבצת"}
                  </p>
                )}
                {r.reason && <p className="text-stone-500">סיבה: {r.reason}</p>}
                {r.requestedFrom && <p className="text-stone-500">החל מ-{dateLabel(r.requestedFrom)}</p>}
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setActive(r)}>
                טיפול בבקשה
              </button>
            </li>
          ))}
        </ul>
      )}
      {active && (
        <DecideDialog
          request={active}
          onClose={() => setActive(null)}
          onDone={(text) => {
            setActive(null);
            tell("success", text);
            onChanged();
          }}
          onError={(text) => tell("error", text)}
        />
      )}
    </section>
  );
}

function DecideDialog({ request, onClose, onDone, onError }: { request: PendingRequest; onClose: () => void; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [note, setNote] = useState("");
  const [from, setFrom] = useState(request.requestedFrom ?? "");
  const [refund, setRefund] = useState(false);
  const { busy, run } = useSingleFlight();

  async function decide(decision: "APPROVE" | "REJECT") {
    await run(async () => {
      const res = await api(`/api/admin/shifts/requests/${request.id}`, { body: { decision, note: note || undefined, effectiveFrom: from || undefined, refundCharged: refund } });
      if (res.ok) onDone(decision === "APPROVE" ? "הבקשה אושרה" : "הבקשה נדחתה");
      else onError(res.data.error ?? "הפעולה נכשלה");
    });
  }

  return (
    <Dialog title={`${REQUEST_KIND_TEXT[request.kind]} · ${request.user.name}`} labelId="decide" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <label className="field-label" htmlFor="dc-from">תאריך כניסה לתוקף (ריק: ברירת מחדל מחודש שטרם חויב)</label>
          <input id="dc-from" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
          להחזיר את מה שכבר חויב עבור מופעים שיוסרו
        </label>
        <div>
          <label className="field-label" htmlFor="dc-note">הערה ללקוח</label>
          <textarea id="dc-note" className="field" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            חזרה
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => decide("REJECT")}>
            דחייה
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide("APPROVE")}>
            אישור
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── זכאות ─────────────────────────────

function EligibilityTab({ rows, query, setQuery, onChanged, tell }: { rows: EligibilityRow[]; query: string; setQuery: (q: string) => void; onChanged: () => void; tell: Tell }) {
  const { busy, run } = useSingleFlight();
  const [draft, setDraft] = useState(query);

  async function toggle(row: EligibilityRow) {
    await run(async () => {
      const res = await api("/api/admin/shifts/eligibility", { method: "PATCH", body: { userId: row.id, allowed: !row.canBookShifts } });
      if (res.ok) {
        tell("success", row.canBookShifts ? "ההרשאה בוטלה" : "ההרשאה ניתנה");
        onChanged();
      } else tell("error", res.data.error ?? "הפעולה נכשלה");
    });
  }

  return (
    <section className="space-y-4">
      <SectionTitle hint="רק לקוח שאושר יכול להזמין משמרת קבועה. הבדיקה מתבצעת בשרת">זכאות להזמנת משמרות</SectionTitle>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft);
        }}
      >
        <input aria-label="חיפוש לקוח" className="field" placeholder="חיפוש לקוח לפי שם, אימייל או טלפון" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="btn btn-secondary">
          חיפוש
        </button>
      </form>
      {rows.length === 0 ? (
        <EmptyState icon="users">{query ? "לא נמצאו לקוחות." : "אין לקוחות מורשים. חפשו לקוח כדי לתת הרשאה."}</EmptyState>
      ) : (
        <ul className="card divide-y divide-cream-100">
          {rows.map((r) => (
            <li key={r.id} className="p-4 flex flex-wrap items-center justify-between gap-3" data-testid="eligibility-row">
              <span className="text-sm">
                <strong>{r.name}</strong>
                <span className="block text-stone-500 text-xs">{r.email ?? r.phone}</span>
              </span>
              <span className="flex items-center gap-3">
                <ToneBadge tone={r.canBookShifts ? "ok" : "neutral"}>{r.canBookShifts ? "מורשה" : "לא מורשה"}</ToneBadge>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => toggle(r)}>
                  {r.canBookShifts ? "ביטול הרשאה" : "מתן הרשאה"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────── חיוב חודשי וסגירת יום ─────────────────────────────

function BillingTab({ runs, onChanged, tell }: { runs: CronRunRow[]; onChanged: () => void; tell: Tell }) {
  const { busy, run } = useSingleFlight();
  const [closeDate, setCloseDate] = useState("");
  const [closeNote, setCloseNote] = useState("");

  async function runBilling() {
    await run(async () => {
      const res = await api<{ outcome?: string; status?: string }>("/api/admin/shifts/billing", { body: {} });
      if (res.ok) {
        tell("success", res.data.outcome === "ALREADY_RUNNING" ? "ריצה אחרת כבר פעילה" : "ריצת החיוב הסתיימה");
        onChanged();
      } else tell("error", res.data.error ?? "הריצה נכשלה");
    });
  }

  async function closeDay() {
    await run(async () => {
      const res = await api<{ skipped?: number; refunded?: number; credited?: number }>("/api/admin/shifts/close-day", { body: { date: closeDate, note: closeNote || undefined } });
      if (res.ok) {
        tell("success", `היום נסגר. משמרות שדולגו: ${res.data.skipped ?? 0}`);
        onChanged();
      } else tell("error", res.data.error ?? "סגירת היום נכשלה");
    });
  }

  return (
    <section className="space-y-6">
      <div className="card p-5 space-y-3">
        <SectionTitle hint="חיוב אוטומטי רץ בתחילת כל חודש. כאן אפשר להריץ ידנית; הריצה בטוחה להרצה חוזרת ולא תחייב פעמיים">חיוב חודשי</SectionTitle>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={runBilling}>
          {busy ? "רץ..." : "הרצת חיוב חודשי עכשיו"}
        </button>
        {runs.length === 0 ? (
          <p className="text-sm text-stone-500">עדיין לא בוצעו ריצות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>תקופה</th>
                  <th>הפעלה</th>
                  <th>מצב</th>
                  <th>התחלה</th>
                  <th>סיכום</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{monthLabel(r.period)}</td>
                    <td>{r.trigger}</td>
                    <td>{r.status}</td>
                    <td className="tabular-nums text-xs">{new Date(r.startedAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}</td>
                    <td className="text-xs">
                      <code dir="ltr">{r.summary ? JSON.stringify(r.summary) : ""}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-5 space-y-3">
        <SectionTitle hint="משמרות באותו יום ידולגו ללא חיוב; מה ששולם יוחזר">סגירת יום</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="field-label" htmlFor="cd-date">תאריך</label>
            <input id="cd-date" type="date" className="field" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="cd-note">הערה</label>
            <input id="cd-note" className="field" maxLength={200} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          </div>
        </div>
        <button type="button" className="btn btn-secondary" disabled={busy || !closeDate} onClick={closeDay}>
          סגירת היום
        </button>
      </div>
    </section>
  );
}
