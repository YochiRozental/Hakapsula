/** תוויות עברית לתצוגת משמרות (טהור, בטוח לשימוש בדפדפן ובשרת). אין כאן חישוב עסקי: רק ניסוח של ערכים שהשרת קבע */

import { SHIFT_WINDOWS } from "@/lib/payments/pricing";

export const WINDOW_NAMES: Record<string, string> = {
  MORNING: "בוקר",
  NOON: "צהריים",
  AFTERNOON: "אחר הצהריים",
  EVENING: "ערב",
};

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function windowLabel(id: string): string {
  const w = SHIFT_WINDOWS.find((x) => x.id === id);
  return w ? `${WINDOW_NAMES[id] ?? id} ${hhmm(w.startMinutes)}–${hhmm(w.endMinutes)}` : id;
}

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
