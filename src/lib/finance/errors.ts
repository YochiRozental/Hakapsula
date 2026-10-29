export type FinanceErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID" | "CONFLICT" | "PROVIDER_UNKNOWN";

export class FinanceError extends Error {
  constructor(
    message: string,
    readonly code: FinanceErrorCode,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

/** מפתח אידמפוטנטיות שמנהל (הממשק) מייצר לכל כוונת פעולה כספית: מונע ביצוע כפול בלחיצה כפולה או בקשה מקבילה */
export const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export function requireClientKey(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_KEY.test(value)) throw new FinanceError("מפתח הפעולה חסר או לא תקין", "INVALID");
  return value;
}

export function requireReason(value: unknown, min = 3, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) throw new FinanceError("יש לציין סיבה", "INVALID");
  return text.slice(0, max);
}

export function requireAgorot(value: unknown, label = "הסכום"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FinanceError(`${label} חייב להיות מספר שלם חיובי של אגורות`, "INVALID");
  }
  return value;
}
