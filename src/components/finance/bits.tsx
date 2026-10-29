"use client";

import { useRef } from "react";
import { shekel } from "@/lib/payments/client";

/** תוויות וכלי עזר משותפים למסכי הניהול הכספי. הדפדפן רק מציג מה שהשרת חישב */

export const PAYMENT_STATUS: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  SUCCEEDED: { label: "הצליח", tone: "ok" },
  PENDING: { label: "ממתין", tone: "pending" },
  FAILED: { label: "נכשל", tone: "bad" },
  CANCELLED: { label: "בוטל", tone: "neutral" },
};

export const PURPOSE_LABEL: Record<string, string> = { BOOKING: "הזמנה", PACKAGE: "חבילת שעות", SHIFT_MONTH: "חיוב משמרת", DEBT: "חוב" };

export const DEBT_STATUS: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  OPEN: { label: "פתוח", tone: "bad" },
  IN_REVIEW: { label: "בבירור", tone: "pending" },
  PAID: { label: "שולם בפועל", tone: "ok" },
  WAIVED: { label: "נמחל", tone: "neutral" },
};

export const REFUND_STATE: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  SUCCEEDED: { label: "בוצע", tone: "ok" },
  FAILED: { label: "נכשל", tone: "bad" },
  PENDING_NOT_SENT: { label: "ממתין (טרם נשלח)", tone: "pending" },
  PENDING_UNKNOWN: { label: "נשלח, מצב לא ידוע", tone: "pending" },
};

export const LEDGER_TYPE: Record<string, string> = { PAYMENT: "תשלום", REFUND: "החזר", DEBT_PAYMENT: "הסדרת חוב", DEBT_WAIVER: "ויתור על חוב" };

export const AUDIT_ACTION: Record<string, string> = {
  BOOKING_APPROVED_WITH_DEBT: "אישור הזמנה עם חוב",
  DEBT_SETTLED: "הסדרת חוב",
  DEBT_WAIVED: "ויתור על חוב",
  DEBT_REVIEW_OPENED: "חוב הועבר לבירור",
  DEBT_REVIEW_CLOSED: "חוב חזר לפתוח",
  CUSTOMER_BLOCKED: "חסימת לקוח",
  CUSTOMER_UNBLOCKED: "שחרור חסימה",
  REFUND_REQUESTED: "החזר מנהל",
  REFUND_EXCEPTION_REQUESTED: "החזר חריג",
  REFUND_SUCCEEDED: "החזר הצליח",
  REFUND_FAILED: "החזר נכשל",
  REFUND_UNKNOWN: "החזר במצב לא ידוע",
  REFUND_VERIFIED: "החזר אומת מול הספק",
  REFUND_VERIFY_INCONCLUSIVE: "אימות החזר לא חד-משמעי",
  REFUND_RESOLVED_MANUAL: "הכרעה ידנית בהחזר",
  REFUND_EXCEPTION_APPROVED: "אישור חריג החזר",
  REFUND_EXCEPTION_REJECTED: "דחיית חריג החזר",
  PACKAGE_CANCEL_APPROVED: "אישור ביטול חבילה",
  PACKAGE_CANCEL_REJECTED: "דחיית ביטול חבילה",
  PAYMENT_VERIFIED: "אימות תשלום מול הספק",
  PAYMENT_VERIFY_INCONCLUSIVE: "אימות תשלום לא חד-משמעי",
  PAYMENT_RESOLVED_MANUAL: "הכרעה ידנית בתשלום",
  SHIFT_CHARGE_UNKNOWN_RESOLVED: "הכרעה בחיוב משמרת לא ידוע",
  INQUIRY_NOTE: "הערת בירור",
};

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" });

/** סכום באגורות מדויקות: ₪ ובסוגריים האגורות השלמות */
export function Money({ agorot, strong }: { agorot: number; strong?: boolean }) {
  return (
    <span className="tabular-nums whitespace-nowrap" title={`${agorot} אגורות`}>
      {strong ? <strong>{shekel(agorot)}</strong> : shekel(agorot)}
      <span className="text-[10px] text-stone-400 mr-1">({agorot} אג׳)</span>
    </span>
  );
}

/** מפתח אידמפוטנטיות לכוונת פעולה אחת: נשאר זהה בלחיצה כפולה ומתחדש רק אחרי הצלחה/שינוי טופס */
export function useIntentKey() {
  const ref = useRef(globalThis.crypto.randomUUID().replace(/-/g, ""));
  return { get: () => ref.current, renew: () => (ref.current = globalThis.crypto.randomUUID().replace(/-/g, "")) };
}

/** המרת שקלים שהוקלדו (עם עד שתי ספרות) לאגורות שלמות, או null אם לא תקין */
export function toAgorot(text: string): number | null {
  const m = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const value = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return value > 0 ? value : null;
}
