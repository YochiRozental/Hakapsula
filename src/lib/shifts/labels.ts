/** תוויות עברית לתצוגת משמרות (טהור, בטוח לשימוש בדפדפן ובשרת). אין כאן חישוב עסקי: רק ניסוח של ערכים שהשרת קבע */

import { windowLabelById } from "@/lib/shifts/windows";

/** שם ושעות של משבצת לפי מזהה. המשבצות נטענות מהמסד ע"י ShiftWindowsProvider (ראו windows.ts) */
export function windowLabel(id: string): string {
  return windowLabelById(id);
}

/** משך בדקות בניסוח קריא: 240 -> "4 שעות", 180 -> "3 שעות", 45 -> "45 דקות", 90 -> "שעה ו-30 דקות" */
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : h === 1 ? "שעה" : `${h} שעות`;
  const mins = m === 0 ? "" : `${m} דקות`;
  return [hours, mins].filter(Boolean).join(" ו-") || "0 דקות";
}

export const MAKEUP_STATE_TEXT: Record<string, string> = {
  PENDING_GRANT: "ממתינה למתן הזיכוי",
  OPEN: "יתרה זמינה",
  USED: "נוצלה",
  EXPIRED: "פג תוקף",
  WAIVED: "ויתור",
};

export const WEEKDAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];

export const SHIFT_STATUS_TEXT: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  PENDING: { label: "ממתינה לאישור חיוב", tone: "pending" },
  ACTIVE: { label: "פעילה", tone: "ok" },
  SUSPENDED: { label: "מושעית", tone: "bad" },
  CANCELLED: { label: "בוטלה", tone: "neutral" },
  ENDED: { label: "הסתיימה", tone: "neutral" },
};

export const CHARGE_STATUS_TEXT: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  PENDING: { label: "ממתין", tone: "pending" },
  PAID: { label: "שולם", tone: "ok" },
  FAILED: { label: "נכשל", tone: "bad" },
  UNKNOWN: { label: "בבירור", tone: "pending" },
  WAIVED: { label: "אופס", tone: "neutral" },
};

export const OCCURRENCE_STATUS_TEXT: Record<string, string> = {
  SCHEDULED: "מתוזמן",
  SKIPPED_CLOSED_DAY: "דולג (יום סגור)",
  CANCELLED: "בוטל",
};

export const REQUEST_STATUS_TEXT: Record<string, { label: string; tone: "ok" | "pending" | "bad" | "neutral" }> = {
  PENDING: { label: "ממתינה להחלטת מנהל", tone: "pending" },
  APPROVED: { label: "אושרה", tone: "ok" },
  REJECTED: { label: "נדחתה", tone: "bad" },
};

export const REQUEST_KIND_TEXT: Record<string, string> = { CHANGE: "שינוי משמרת", CANCEL: "ביטול משמרת" };

const FAILURE_TEXT: Record<string, string> = {
  card_declined: "הכרטיס נדחה",
  no_usable_method: "אין אמצעי תשלום שמיש",
  provider_error: "תקלה אצל ספק התשלום",
  interrupted: "החיוב נקטע לפני שהסתיים",
  duplicate_attempt: "ניסיון חיוב כפול",
  status_check_failed: "לא ניתן היה לאמת את מצב החיוב",
  amount_mismatch: "סכום החיוב שהתקבל אינו תואם",
  pending_at_provider: "החיוב ממתין אצל הספק",
  manual_not_charged: "נקבע ידנית שלא חויב",
  manual_payment_overdue: "התשלום הידני לא התקבל במועד",
};
export const failureText = (code: string | null | undefined) => (code ? FAILURE_TEXT[code] ?? "שגיאה בחיוב" : "");

/** "payment_failed:2027-03" -> "חיוב מרץ 2027 נכשל" ; "manual:..." -> השעיה ידנית */
export function suspensionText(reason: string | null | undefined): string {
  if (!reason) return "";
  if (reason.startsWith("payment_failed:")) return `חיוב חודש ${monthLabel(reason.slice("payment_failed:".length))} לא הוסדר בתוך שבעה ימים`;
  if (reason.startsWith("manual:")) return `הושעתה על ידי מנהל${reason.length > 7 ? `: ${reason.slice(7)}` : ""}`;
  return reason;
}

const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return y && m ? `${MONTHS[m - 1]} ${y}` : month;
}

/** תאריך ISO (YYYY-MM-DD) -> 15.2.2027, בלי המרת אזור זמן */
export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return y ? `${d}.${m}.${y}` : iso;
}
