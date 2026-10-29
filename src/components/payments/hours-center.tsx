"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, EmptyState, Icon, Loading, SectionTitle, StatCard } from "@/components/ui";
import type { IconName } from "@/components/ui";
import { PaymentStatusBadge, SandboxNotice, SandboxPanel } from "@/components/payments/bits";
import {
  REFUND_REASON_TEXT,
  api,
  dateText,
  dateTimeText,
  durationText,
  shekel,
  usePaymentsGate,
  useSingleFlight,
} from "@/lib/payments/client";
import { HOURS_PACKAGES, packageSavingsAgorot } from "@/lib/payments/pricing";
import type { BalanceView, HistoryEntry, PackageView } from "@/lib/payments/views";

type Tab = "balance" | "buy" | "history";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "balance", label: "היתרה שלי", icon: "clock" },
  { id: "buy", label: "רכישת חבילה", icon: "card" },
  { id: "history", label: "היסטוריה", icon: "list" },
];

export function HoursCenter({ canPurchase }: { canPurchase: boolean }) {
  const gate = usePaymentsGate();
  const [tab, setTab] = useState<Tab>("balance");
  const [balanceVersion, setBalanceVersion] = useState(0);
  const bump = () => setBalanceVersion((v) => v + 1);

  return (
    <div className="space-y-6">
      {gate.sandbox && <SandboxNotice />}
      <div role="tablist" aria-label="חבילות שעות" className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`btn btn-sm shrink-0 ${tab === t.id ? "btn-primary" : "btn-secondary"}`}
          >
            <Icon name={t.icon} className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "balance" && <BalanceTab key={balanceVersion} onBuy={() => setTab("buy")} />}
      {tab === "buy" && <BuyTab canPurchase={canPurchase} sandbox={gate.sandbox} onActivated={bump} />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

// ───────────────────────────── יתרה ─────────────────────────────

const REQUEST_TEXT = {
  PENDING: { label: "בקשת ביטול ממתינה לבדיקת מנהל", cls: "bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200" },
  APPROVED: { label: "בקשת הביטול אושרה", cls: "bg-brand-50 text-brand-700 ring-1 ring-brand-100" },
  REJECTED: { label: "בקשת הביטול נדחתה", cls: "bg-red-50 text-red-700 ring-1 ring-red-100" },
} as const;

function BalanceTab({ onBuy }: { onBuy: () => void }) {
  const [view, setView] = useState<BalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<PackageView | null>(null);

  const load = useCallback(async () => {
    const res = await api<BalanceView>("/api/payments/balance");
    if (res.ok) setView(res.data as BalanceView);
    else setError(res.data.error ?? "שגיאה בטעינת היתרה");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת היתרה מהשרת בעת פתיחת הלשונית
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!view) return <Loading />;

  const nothing = view.packages.length === 0 && view.credits.length === 0;

  return (
    <div className="space-y-6">
      {success && <Alert tone="success">{success}</Alert>}
      <StatCard label="סך היתרה הזמינה" value={durationText(view.totalMinutes)} icon="clock" tone="brand" />

      {nothing ? (
        <EmptyState icon="clock">
          אין לכם כרגע חבילה פעילה.
          <button type="button" onClick={onBuy} className="block mx-auto mt-3 btn btn-primary btn-sm">
            לרכישת חבילה
          </button>
        </EmptyState>
      ) : (
        <>
          {view.packages.length > 0 && (
            <section>
              <SectionTitle hint="ניצול לפי תוקף: החבילה שפוקעת ראשונה מנוצלת ראשונה">חבילות פעילות</SectionTitle>
              <ul className="grid gap-4 sm:grid-cols-2">
                {view.packages.map((p) => (
                  <PackageCard key={p.id} pkg={p} onCancel={() => setCancelFor(p)} />
                ))}
              </ul>
            </section>
          )}
          {view.credits.length > 0 && (
            <section>
              <SectionTitle hint="זיכויים מהחזרת דקות מחבילה שפג תוקפה. תקפים 30 יום, ומנוצלים לפני תשלום רגיל">זיכויים</SectionTitle>
              <ul className="grid gap-4 sm:grid-cols-2">
                {view.credits.map((c) => (
                  <li key={c.id} className="card p-5" data-testid="credit">
                    <p className="font-display text-lg font-bold text-stone-900">זיכוי {durationText(c.minutesRemaining)}</p>
                    <p className="text-sm text-stone-500 mt-1">
                      התקבל ב-{dateText(c.createdAt)} · בתוקף עד <strong>{dateText(c.expiresAt)}</strong>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {view.exhaustedPackages.length > 0 && (
        <details className="card p-5">
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">חבילות שנוצלו במלואן ({view.exhaustedPackages.length})</summary>
          <ul className="mt-3 space-y-2 text-sm text-stone-600">
            {view.exhaustedPackages.map((p) => (
              <li key={p.id}>
                חבילת {p.hours} שעות · נרכשה {dateText(p.purchasedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(view.expiredPackages.length > 0 || view.expiredCredits.length > 0) && (
        <details className="card p-5" data-testid="expired">
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">
            פג תוקפן, לא נכללות ביתרה הזמינה ({view.expiredPackages.length + view.expiredCredits.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-stone-600">
            {view.expiredPackages.map((p) => (
              <li key={p.id}>
                חבילת {p.hours} שעות · פגה ב-{dateText(p.expiresAt)} · נותרו {durationText(p.minutesRemaining)} שלא נוצלו
              </li>
            ))}
            {view.expiredCredits.map((c) => (
              <li key={c.id}>
                זיכוי {durationText(c.minutesTotal)} · פג ב-{dateText(c.expiresAt)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {cancelFor && (
        <CancelRequestDialog
          pkg={cancelFor}
          onClose={() => setCancelFor(null)}
          onSent={() => {
            setCancelFor(null);
            setSuccess("בקשת הביטול נשלחה וממתינה לבדיקת מנהל. החבילה נשארת פעילה עד להחלטה.");
            void load();
          }}
        />
      )}
    </div>
  );
}

function PackageCard({ pkg, onCancel }: { pkg: PackageView; onCancel: () => void }) {
  const req = pkg.cancellationRequest;
  // יחס לתצוגת פס בלבד: הערכים עצמם מגיעים מהשרת
  const pct = pkg.minutesTotal > 0 ? Math.round((pkg.minutesRemaining / pkg.minutesTotal) * 100) : 0;
  const canRequest = !req || req.status === "REJECTED";
  return (
    <li className="card p-5 space-y-3" data-testid="package">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-stone-900">חבילת {pkg.hours} שעות</p>
          <p className="text-xs text-stone-400 mt-0.5">שולם {shekel(pkg.pricePaidAgorot)}</p>
        </div>
        <p className="font-display text-2xl font-bold text-brand-700 tabular-nums text-left">{durationText(pkg.minutesRemaining)}</p>
      </div>
      <div className="h-2 rounded-full bg-cream-200 overflow-hidden" aria-hidden="true">
        <div className="h-full rounded-full bg-linear-to-l from-brand-500 to-bronze-400" style={{ width: `${pct}%` }} />
      </div>
      <dl className="text-sm text-stone-500 grid grid-cols-2 gap-y-1">
        <dt>נרכשה</dt>
        <dd className="text-stone-800 font-semibold tabular-nums">{dateText(pkg.purchasedAt)}</dd>
        <dt>בתוקף עד</dt>
        <dd className="text-stone-800 font-semibold tabular-nums">{dateText(pkg.expiresAt)}</dd>
        <dt>נותר מתוך</dt>
        <dd className="text-stone-800 font-semibold">{durationText(pkg.minutesTotal)}</dd>
      </dl>
      {req && <span className={`badge ${REQUEST_TEXT[req.status].cls}`}>{REQUEST_TEXT[req.status].label}</span>}
      {canRequest && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          בקשת ביטול חבילה
        </button>
      )}
    </li>
  );
}

function CancelRequestDialog({ pkg, onClose, onSent }: { pkg: PackageView; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  async function submit() {
    await run(async () => {
      setError(null);
      const res = await api(`/api/payments/packages/${pkg.id}/cancel-request`, { body: { reason } });
      if (res.ok) onSent();
      else setError(res.data.error ?? "לא ניתן לשלוח את הבקשה");
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/40 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title" className="card w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 id="cancel-dialog-title" className="font-display text-xl font-bold text-stone-900">
          בקשת ביטול חבילת {pkg.hours} שעות
        </h2>
        <p className="text-sm text-stone-600">
          הבקשה <strong>אינה מבטלת את החבילה ואינה מבצעת החזר אוטומטי</strong>. היא תיבדק על ידי מנהל בהתאם למדיניות ולדין, ועד להחלטה
          החבילה נשארת פעילה וניתנת לשימוש.
        </p>
        <div>
          <label htmlFor="cancel-reason" className="field-label">
            סיבת הביטול <span className="font-normal text-stone-400">(לא חובה)</span>
          </label>
          <textarea id="cancel-reason" className="field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            חזרה
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "שולח..." : "שליחת בקשת ביטול"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── רכישת חבילות ─────────────────────────────

interface Purchase {
  paymentId: string;
  providerPaymentId?: string;
  hours: number;
  amountAgorot: number;
}

type PurchaseMessage = { tone: "success" | "error" | "warn"; text: string };

const PURCHASE_STORAGE = "hours:purchase";
const POLL_MS = 4000;

function newClientKey(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function BuyTab({ canPurchase, sandbox, onActivated }: { canPurchase: boolean; sandbox: boolean; onActivated: () => void }) {
  const [confirming, setConfirming] = useState<{ hours: number; priceAgorot: number; key: string } | null>(null);
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [message, setMessage] = useState<PurchaseMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();
  const checking = useRef(false);

  const verify = useCallback(
    async (p: Purchase) => {
      if (checking.current) return;
      checking.current = true;
      try {
        const res = await api<{ outcome?: string; package?: { hours: number } | null }>(`/api/payments/${p.paymentId}`);
        if (!res.ok) {
          setMessage({ tone: "error", text: res.data.error ?? "לא ניתן לאמת את התשלום כעת" });
          return;
        }
        const outcome = res.data.outcome;
        if (outcome === "PACKAGE_ACTIVATED" || outcome === "ALREADY_ACTIVATED") {
          // הצלחה מוצגת רק אחרי שהשרת אישר שהחבילה הופעלה
          window.sessionStorage.removeItem(PURCHASE_STORAGE);
          setPurchase(null);
          setMessage({ tone: "success", text: `החבילה הופעלה: ${durationText((res.data.package?.hours ?? p.hours) * 60)} נוספו ליתרה שלכם.` });
          onActivated();
        } else if (outcome === "PAYMENT_FAILED") {
          window.sessionStorage.removeItem(PURCHASE_STORAGE);
          setPurchase(null);
          setMessage({ tone: "error", text: "התשלום נכשל ולא בוצע חיוב. לא נוספה יתרה. אפשר לנסות שוב." });
        } else if (outcome === "PAYMENT_CANCELLED") {
          window.sessionStorage.removeItem(PURCHASE_STORAGE);
          setPurchase(null);
          setMessage({ tone: "warn", text: "התשלום בוטל ולא בוצע חיוב. לא נוספה יתרה." });
        } else if (outcome === "AMOUNT_MISMATCH") {
          window.sessionStorage.removeItem(PURCHASE_STORAGE);
          setPurchase(null);
          setMessage({ tone: "error", text: "סכום התשלום אינו תואם לחבילה ולכן היא לא הופעלה. אנא צרו קשר." });
        }
      } finally {
        checking.current = false;
      }
    },
    [onActivated]
  );

  // המשך אחרי רענון דף: הרכישה הממתינה נשמרת בסשן, ומצבה נשאל מחדש מהשרת
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(PURCHASE_STORAGE);
      if (!raw) return;
      const p = JSON.parse(raw) as Purchase;
      if (p?.paymentId) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- שחזור רכישה ממתינה שנשמרה בסשן
        setPurchase(p);
        void verify(p);
      }
    } catch {
      // אחסון פגום: מתעלמים
    }
  }, [verify]);

  useEffect(() => {
    if (!purchase) return;
    const id = window.setInterval(() => void verify(purchase), POLL_MS);
    return () => window.clearInterval(id);
  }, [purchase, verify]);

  async function start() {
    if (!confirming) return;
    const { hours, key } = confirming;
    await run(async () => {
      setError(null);
      setMessage(null);
      const res = await api<{ paymentId: string; providerPaymentId?: string; hours: number; amountAgorot: number }>(
        "/api/payments/packages/purchase",
        // נשלחים רק מספר השעות ומפתח אידמפוטנטיות: המחיר נקבע בשרת
        { body: { hours, clientKey: key } }
      );
      if (!res.ok) {
        setError(res.data.error ?? "לא ניתן להתחיל את הרכישה");
        return;
      }
      const p: Purchase = {
        paymentId: res.data.paymentId,
        providerPaymentId: res.data.providerPaymentId,
        hours: res.data.hours,
        amountAgorot: res.data.amountAgorot,
      };
      window.sessionStorage.setItem(PURCHASE_STORAGE, JSON.stringify(p));
      setConfirming(null);
      setPurchase(p);
      void verify(p);
    });
  }

  return (
    <div className="space-y-6">
      {!canPurchase && (
        <Alert tone="error">רכישת חבילות זמינה ללקוחות מאושרים בלבד. אחרי אישור החשבון תוכלו לרכוש חבילה.</Alert>
      )}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`rounded-xl px-4 py-3 text-sm border ${
            message.tone === "success"
              ? "bg-brand-50 text-brand-700 border-brand-100"
              : message.tone === "error"
                ? "bg-red-50 text-red-700 border-red-100"
                : "bg-bronze-50 text-bronze-700 border-bronze-200"
          }`}
        >
          {message.text}
        </p>
      )}

      {purchase && (
        <section className="card p-5 sm:p-8 space-y-4" data-testid="purchase-status">
          <SectionTitle aside={<PaymentStatusBadge status="PENDING" />}>רכישת חבילת {purchase.hours} שעות</SectionTitle>
          <p className="text-sm text-stone-600">
            סכום לתשלום: <strong>{shekel(purchase.amountAgorot)}</strong>. החבילה תופעל רק לאחר שהשרת יאמת את התשלום. ניתן לרענן את הדף בבטחה.
          </p>
          {sandbox && purchase.providerPaymentId && (
            <SandboxPanel providerPaymentId={purchase.providerPaymentId} onDone={() => void verify(purchase)} />
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void verify(purchase)}>
            בדיקת סטטוס עכשיו
          </button>
        </section>
      )}

      <section>
        <SectionTitle hint="כל חבילה תקפה שנה מיום הרכישה, לכל החדרים, וניצולה לפי דקות">חבילות שעות</SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HOURS_PACKAGES.map((p) => (
            <li key={p.hours} className="card card-hover p-5 flex flex-col gap-3" data-testid="package-offer">
              <p className="font-display text-3xl font-bold text-stone-900">{p.hours} שעות</p>
              <p className="font-display text-2xl font-bold text-brand-700 tabular-nums">{shekel(p.priceAgorot)}</p>
              <ul className="text-sm text-stone-500 space-y-1">
                <li>{shekel(Math.round(p.priceAgorot / p.hours))} לשעה</li>
                <li>חיסכון של {shekel(packageSavingsAgorot(p))} לעומת מחיר רגיל</li>
                <li>תוקף: שנה מיום הרכישה</li>
              </ul>
              <button
                type="button"
                className="btn btn-primary mt-auto"
                disabled={!canPurchase || busy || !!purchase}
                onClick={() => {
                  setError(null);
                  setConfirming({ hours: p.hours, priceAgorot: p.priceAgorot, key: newClientKey() });
                }}
              >
                רכישה
              </button>
            </li>
          ))}
        </ul>
      </section>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/40 p-4" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="buy-dialog-title" className="card w-full max-w-md p-6 space-y-4">
            <h2 id="buy-dialog-title" className="font-display text-xl font-bold text-stone-900">
              רכישת חבילת {confirming.hours} שעות
            </h2>
            <p className="text-sm text-stone-600">
              סכום לתשלום: <strong>{shekel(confirming.priceAgorot)}</strong>. החבילה תקפה שנה מיום הרכישה.
              {sandbox && " התשלום מדומה: לא מתבצע חיוב אמיתי ולא מוזנים פרטי כרטיס."}
            </p>
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>
                חזרה
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>
                {busy ? "פותח תשלום..." : "המשך לתשלום"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── היסטוריה ─────────────────────────────

function HistoryTab() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: HistoryEntry[] }>("/api/payments/history").then((res) => {
      if (res.ok) setEntries(res.data.entries);
      else setError(res.data.error ?? "שגיאה בטעינת ההיסטוריה");
    });
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!entries) return <Loading />;
  if (entries.length === 0) return <EmptyState icon="list">אין עדיין תשלומים או ניצולי דקות.</EmptyState>;

  return (
    <ul className="card divide-y divide-cream-100 overflow-hidden" data-testid="history">
      {entries.map((e) => (
        <HistoryRow key={e.id} e={e} />
      ))}
    </ul>
  );
}

function describe(e: HistoryEntry): { title: string; detail?: string; icon: IconName } {
  const where = e.roomName && e.startTime ? `${e.roomName} · ${dateTimeText(e.startTime)}` : undefined;
  switch (e.kind) {
    case "PACKAGE_PURCHASE":
      return { title: `רכישת חבילת ${e.hours ?? ""} שעות`, icon: "card" };
    case "BOOKING_PAYMENT":
      return {
        title: "תשלום על הזמנה",
        detail: [where, e.minutes ? `כולל ${durationText(e.minutes)} מהיתרה (יינוכו באישור)` : null].filter(Boolean).join(" · "),
        icon: "calendarCheck",
      };
    case "MINUTES_USED":
      return { title: `ניצול ${durationText(e.minutes ?? 0)} מהיתרה`, detail: where, icon: "clock" };
    case "MINUTES_RESTORED":
      return {
        title: e.convertedToCredit
          ? `החזרת ${durationText(e.minutes ?? 0)}: הומרו לזיכוי כי החבילה המקורית פגה`
          : `החזרת ${durationText(e.minutes ?? 0)} ליתרה`,
        detail: where,
        icon: "arrowUp",
      };
    case "CREDIT_GRANTED":
      return { title: `זיכוי ${durationText(e.minutes ?? 0)}`, detail: e.expiresAt ? `בתוקף עד ${dateText(e.expiresAt)}` : undefined, icon: "sparkle" };
    case "REFUND":
      return {
        title: "החזר כספי",
        detail: [where, e.reasonCode ? REFUND_REASON_TEXT[e.reasonCode] ?? null : null].filter(Boolean).join(" · "),
        icon: "arrowDown",
      };
  }
}

function HistoryRow({ e }: { e: HistoryEntry }) {
  const d = describe(e);
  return (
    <li className="px-4 sm:px-5 py-3.5 flex items-start gap-3 text-sm">
      <span className="w-9 h-9 rounded-full bg-bronze-50 text-bronze-600 ring-1 ring-bronze-100 flex items-center justify-center shrink-0">
        <Icon name={d.icon} className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-stone-800">{d.title}</p>
        {d.detail && <p className="text-stone-500 mt-0.5">{d.detail}</p>}
        <p className="text-xs text-stone-400 mt-0.5 tabular-nums">{dateTimeText(e.at)}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {e.amountAgorot !== undefined && (
          <span className={`font-semibold tabular-nums ${e.kind === "REFUND" ? "text-brand-700" : "text-stone-800"}`}>
            {e.kind === "REFUND" ? "+" : ""}
            {shekel(e.amountAgorot)}
          </span>
        )}
        {e.status && (e.kind === "PACKAGE_PURCHASE" || e.kind === "BOOKING_PAYMENT" || e.kind === "REFUND") && <PaymentStatusBadge status={e.status} />}
      </div>
    </li>
  );
}
