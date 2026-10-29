"use client";

import { useEffect, useRef, useState } from "react";

/**
 * עזרי צד לקוח לממשק התשלומים. הדפדפן אינו מחשב כאן יתרות, מחירים או פקיעה עסקית: הוא רק מציג את מה שהשרת החזיר
 * ומנעל לחיצות כפולות. כל החלטה (אישור הזמנה, הפעלת חבילה, החזר) נשארת בשרת.
 */

// ───────────────────────────── שער ההפעלה ─────────────────────────────

export interface PaymentsGate {
  /** false עד שהשרת ענה */
  loaded: boolean;
  /** זרימת התשלום פעילה בסביבה זו. ברירת המחדל: סגורה */
  enabled: boolean;
  /** פאנל התשלום המדומה מותר (Mock בסביבת פיתוח מקומית בלבד) */
  sandbox: boolean;
}

/**
 * קורא את שער ההפעלה מהשרת. כשהשרת מחזיר 404 (כל סביבה חיה כיום) הזרימה החדשה לא קיימת והממשק נשאר במסלול הקיים.
 * כל כשל (רשת, שגיאה) נחשב כסגור.
 */
export function usePaymentsGate(): PaymentsGate {
  const [gate, setGate] = useState<PaymentsGate>({ loaded: false, enabled: false, sandbox: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/payments/status")
      .then(async (res) => {
        if (!res.ok) return { enabled: false, sandbox: false };
        const body = (await res.json()) as { enabled?: boolean; sandbox?: boolean };
        return { enabled: body.enabled === true, sandbox: body.sandbox === true };
      })
      .catch(() => ({ enabled: false, sandbox: false }))
      .then((g) => {
        if (!cancelled) setGate({ loaded: true, ...g });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return gate;
}

/** בדיקה חד-פעמית של השער, עם תקרת זמן. כל כשל או איחור נחשבים כסגור, כדי שהמסלול הקיים לעולם לא ייחסם */
export async function probeGate(): Promise<boolean> {
  try {
    const res = await fetch("/api/payments/status", { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ───────────────────────────── קריאות API ─────────────────────────────

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T & { error?: string; code?: string };
}

export async function api<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "שגיאת רשת, נסו שוב" } as ApiResult<T>["data"] };
  }
}

/** מונע הפעלה כפולה של פעולה בזמן שהקודמת רצה (לחיצה כפולה). מחזיר undefined אם כבר רצה פעולה */
export function useSingleFlight() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}

// ───────────────────────────── שעון ספירה לאחור ─────────────────────────────

/**
 * ספירה לאחור עד פקיעת ההחזקה, לתצוגה בלבד. חישוב ההפרש נעשה מול זמן השרת (serverNow) שהוחזר באותה תשובה,
 * כך שסטייה בשעון הדפדפן לא משנה. כשהשעון מגיע לאפס נקרא onExpire, והמצב הסופי נקבע שוב ע"י השרת.
 */
export function useHoldCountdown(holdExpiresAt: string | null, serverNow: string | null, onExpire: () => void) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const expireRef = useRef(onExpire);
  useEffect(() => {
    expireRef.current = onExpire;
  });

  useEffect(() => {
    if (!holdExpiresAt || !serverNow) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- אין החזקה פעילה: מאפסים את התצוגה
      setRemainingMs(null);
      return;
    }
    const receivedAt = Date.now();
    const initial = Date.parse(holdExpiresAt) - Date.parse(serverNow);
    let fired = false;
    const tick = () => {
      const left = Math.max(0, initial - (Date.now() - receivedAt));
      setRemainingMs(left);
      if (left === 0 && !fired) {
        fired = true;
        expireRef.current();
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [holdExpiresAt, serverNow]);

  return remainingMs;
}

// ───────────────────────────── עיצוב תצוגה ─────────────────────────────

/** 2600 -> "₪26"; 4160 -> "₪41.60". תצוגה בלבד */
export function shekel(agorot: number): string {
  const whole = Math.floor(Math.abs(agorot) / 100);
  const frac = Math.abs(agorot) % 100;
  const body = whole.toLocaleString("he-IL") + (frac ? `.${String(frac).padStart(2, "0")}` : "");
  return `${agorot < 0 ? "-" : ""}₪${body}`;
}

/** 90 -> "שעה ו-30 דקות"; 45 -> "45 דקות"; 600 -> "10 שעות" */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`;
  const mins = m === 0 ? "" : `${m} דקות`;
  if (hours && mins) return `${hours} ו-${mins}`;
  return hours || mins || "0 דקות";
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const dateText = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "numeric" });
export const timeText = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
export const dateTimeText = (iso: string) => `${dateText(iso)} ${timeText(iso)}`;

export const PAYMENT_STATUS_TEXT: Record<string, { label: string; tone: "pending" | "ok" | "bad" | "neutral" }> = {
  PENDING: { label: "ממתין", tone: "pending" },
  SUCCEEDED: { label: "הצליח", tone: "ok" },
  FAILED: { label: "נכשל", tone: "bad" },
  CANCELLED: { label: "בוטל", tone: "neutral" },
};

export const REFUND_REASON_TEXT: Record<string, string> = {
  late_payment_no_confirmation: "התשלום התקבל אחרי שההחזקה פגה",
  balance_changed_during_payment: "יתרת החבילה השתנתה בזמן התשלום",
  cancellation_24h_or_more: "ביטול הזמנה לפחות 24 שעות מראש",
  admin_approved_exception: "חריג שאושר על ידי מנהל",
};
