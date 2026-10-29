"use client";

import type { ReactNode } from "react";
import { Alert, Icon } from "@/components/ui";
import { PAYMENT_STATUS_TEXT, api, useSingleFlight } from "@/lib/payments/client";

/** תג סטטוס תשלום: ממתין / הצליח / נכשל / בוטל */
export function PaymentStatusBadge({ status }: { status: string }) {
  const info = PAYMENT_STATUS_TEXT[status] ?? { label: status, tone: "neutral" as const };
  const tone = {
    pending: "bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200",
    ok: "bg-brand-50 text-brand-700 ring-1 ring-brand-100",
    bad: "bg-red-50 text-red-700 ring-1 ring-red-100",
    neutral: "bg-cream-100 text-stone-600 ring-1 ring-cream-300",
  }[info.tone];
  return <span className={`badge ${tone}`}>{info.label}</span>;
}

/** פס הסבר קבוע שהתשלום מדומה. מוצג בכל מסך תשלום פעיל, אך אינו מופיע בסביבה חיה (שם הזרימה כולה סגורה) */
export function SandboxNotice() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-dashed border-bronze-300 bg-bronze-50/70 px-4 py-3 text-sm text-bronze-700">
      <Icon name="sparkle" className="w-4 h-4 mt-0.5 shrink-0" />
      <span>
        <strong>תשלום מדומה, סביבת בדיקות.</strong> לא מתבצע חיוב אמיתי ולא מוזנים פרטי כרטיס אשראי.
      </span>
    </p>
  );
}

/**
 * פאנל לסימולציית עמוד התשלום של הספק: הצלחה, כישלון וביטול. מוצג רק כשהשרת מצהיר sandbox (Mock מקומי), ופונה
 * לנקודת קצה שקיימת רק באותה סביבה. אחרי הלחיצה הממשק לא מסיק דבר מהתוצאה: הוא מבקש מהשרת לאמת את התשלום.
 */
export function SandboxPanel({ providerPaymentId, onDone }: { providerPaymentId: string; onDone: () => void }) {
  const { busy, run } = useSingleFlight();
  const act = (outcome: "success" | "failure" | "cancel") =>
    run(async () => {
      await api(`/api/dev/mock-payments/${providerPaymentId}/complete`, { body: { outcome } });
      onDone();
    });
  return (
    <div className="rounded-2xl border border-dashed border-bronze-300 bg-bronze-50/60 p-4 space-y-3" data-testid="sandbox-panel">
      <p className="text-sm font-semibold text-bronze-700">סימולציית עמוד התשלום של הספק (סביבת פיתוח בלבד)</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => act("success")} className="btn btn-primary btn-sm">
          תשלום מוצלח
        </button>
        <button type="button" disabled={busy} onClick={() => act("failure")} className="btn btn-danger btn-sm">
          תשלום שנכשל
        </button>
        <button type="button" disabled={busy} onClick={() => act("cancel")} className="btn btn-secondary btn-sm">
          ביטול התשלום
        </button>
      </div>
    </div>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm border-b border-cream-100 last:border-0">
      <span className="text-stone-500">{label}</span>
      <span className="font-semibold text-stone-800 tabular-nums text-left">{children}</span>
    </div>
  );
}

export { Alert };
