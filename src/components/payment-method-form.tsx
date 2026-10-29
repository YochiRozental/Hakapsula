"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, EmptyState, Icon } from "@/components/ui";
import type { PaymentMethodView } from "@/lib/payments/saved-methods";

/**
 * שמירת אמצעי תשלום מדומה לבדיקות. אין כאן שום שדה כרטיס אשראי, תוקף או CVV: הלחיצה מבקשת מהשרת להנפיק אמצעי תשלום
 * מדומה, אחרי אימות בסיסמת האתר. הטוקן לעולם לא מגיע לדפדפן.
 */
export function PaymentMethodForm() {
  const [methods, setMethods] = useState<PaymentMethodView[] | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/payments/payment-methods");
    if (res.ok) setMethods((await res.json()).methods);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת הרשימה מהשרת בעת פתיחת העמוד
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/payments/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 429
            ? `בוצעו יותר מדי ניסיונות. נסו שוב בעוד ${Math.ceil((data.retryAfterSeconds ?? 900) / 60)} דקות`
            : data.error ?? "שגיאה בשמירה"
        );
        return;
      }
      setSuccess("אמצעי תשלום מדומה נשמר.");
      await load();
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/payments/payment-methods/${id}`, { method: "DELETE" });
      if (!res.ok) setError("שגיאה בהסרה");
      else setSuccess("אמצעי התשלום הוסר.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <p className="flex items-start gap-2 rounded-xl border border-dashed border-bronze-300 bg-bronze-50/70 px-4 py-3 text-sm text-bronze-700">
        <Icon name="sparkle" className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          <strong>כרטיס מדומה, סביבת בדיקות בלבד.</strong> לא מוזנים פרטי כרטיס אשראי ולא מתבצע חיוב אמיתי.
        </span>
      </p>

      <section className="card p-5 sm:p-8 space-y-4">
        <p className="font-display text-lg font-bold text-stone-900">אמצעי התשלום השמורים</p>
        {methods === null ? null : methods.length === 0 ? (
          <EmptyState icon="card">אין אמצעי תשלום שמור.</EmptyState>
        ) : (
          <ul className="divide-y divide-cream-100">
            {methods.map((m) => (
              <li key={m.id} className="py-3 flex items-center gap-3 text-sm">
                <Icon name="card" className="w-5 h-5 text-bronze-600" />
                <span className="flex-1">
                  <span className="font-semibold text-stone-800" dir="ltr">
                    •••• {m.last4}
                  </span>
                  {m.sandbox && <span className="badge bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200 mr-2">מדומה</span>}
                  {m.expiry && <span className="text-stone-400 mr-2">{m.expiry}</span>}
                </span>
                <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => remove(m.id)}>
                  הסרה
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={add} className="card p-5 sm:p-8 space-y-4" autoComplete="off">
        <p className="font-display text-lg font-bold text-stone-900">שמירת כרטיס מדומה</p>
        <div>
          <label htmlFor="pm-password" className="field-label">סיסמת האתר (לאימות)</label>
          <input
            id="pm-password"
            required
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
          />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}
        <button type="submit" disabled={busy} className="btn btn-primary w-full py-3!">
          {busy ? "שומר..." : "שמירת כרטיס מדומה"}
        </button>
      </form>
    </div>
  );
}
