"use client";

import { useEffect, useState } from "react";
import { Alert, Icon } from "@/components/ui";

type Status = { hasPin: boolean; updatedAt: string | null };

/**
 * הגדרה/שינוי של הקוד הטלפוני. הקוד לא מוצג ולא נשמר בדפדפן: השדות מתרוקנים אחרי השמירה, ואין כאן שום אימות קוד
 * (האימות נעשה אך ורק בשרת). נדרשת סיסמת האתר לאימות מחדש.
 */
export function IvrPinForm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadStatus() {
    const res = await fetch("/api/profile/ivr-pin");
    if (res.ok) setStatus(await res.json());
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת הסטטוס מהשרת בעת פתיחת העמוד
    loadStatus();
  }, []);

  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, 4);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setSuccess(null);
    if (pin.length !== 4) return setError("הקוד חייב להכיל ארבע ספרות בדיוק");
    if (pin !== pinConfirm) return setError("הקודים שהוקלדו אינם זהים");

    setLoading(true);
    try {
      const res = await fetch("/api/profile/ivr-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, pin, pinConfirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 429
            ? `בוצעו יותר מדי ניסיונות. נסו שוב בעוד ${Math.ceil((data.retryAfterSeconds ?? 900) / 60)} דקות`
            : data.error ?? "שגיאה בשמירת הקוד"
        );
        return;
      }
      setSuccess(data.replaced ? "הקוד הטלפוני עודכן." : "הקוד הטלפוני נקבע.");
      await loadStatus();
    } finally {
      // בכל מקרה מרוקנים את השדות הרגישים
      setPassword("");
      setPin("");
      setPinConfirm("");
      setLoading(false);
    }
  }

  return (
    <div className="card p-5 sm:p-8 space-y-6 max-w-xl">
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-2xl bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center shrink-0">
          <Icon name="lock" className="w-5 h-5" />
        </span>
        <div>
          <p className="font-display text-lg font-bold text-stone-900">
            {status === null ? "קוד טלפוני" : status.hasPin ? "הקוד הטלפוני מוגדר" : "הקוד הטלפוני טרם הוגדר"}
          </p>
          <p className="text-sm text-stone-500 mt-1">
            קוד בן ארבע ספרות שמזהה אתכם בשיחה טלפונית. הוא נפרד מסיסמת האתר, ואינו מוצג לאחר השמירה.
            {status?.updatedAt && ` עודכן לאחרונה ב-${new Date(status.updatedAt).toLocaleDateString("he-IL")}.`}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5" autoComplete="off">
        <div>
          <label htmlFor="ivr-password" className="field-label">סיסמת האתר (לאימות)</label>
          <input
            id="ivr-password"
            required
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="ivr-pin" className="field-label">{status?.hasPin ? "קוד טלפוני חדש" : "קוד טלפוני"} (4 ספרות)</label>
          <input
            id="ivr-pin"
            required
            type="password"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            dir="ltr"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
            className="field tracking-[0.5em]"
          />
        </div>
        <div>
          <label htmlFor="ivr-pin-confirm" className="field-label">הקלדת הקוד שוב</label>
          <input
            id="ivr-pin-confirm"
            required
            type="password"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            dir="ltr"
            autoComplete="off"
            value={pinConfirm}
            onChange={(e) => setPinConfirm(digitsOnly(e.target.value))}
            className="field tracking-[0.5em]"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "שומר..." : status?.hasPin ? "עדכון הקוד" : "שמירת הקוד"}
        </button>
      </form>
    </div>
  );
}
