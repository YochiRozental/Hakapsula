export type ShiftErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID"
  | "CONFLICT"
  | "NO_PAYMENT_METHOD"
  | "BLOCKED"
  | "INVALID_PASSWORD";

export interface ShiftConflict {
  /** YYYY-MM-DD, או ריק כשהבעיה כללית */
  date: string;
  reason: string;
}

/** שגיאת שירות משמרות. details מכיל, כשרלוונטי, רשימת התנגשויות ספציפיות לפי תאריך להצגה בממשק */
export class ShiftError extends Error {
  constructor(
    message: string,
    readonly code: ShiftErrorCode,
    readonly details?: { conflicts?: ShiftConflict[]; retryAfterSeconds?: number; attemptsLeft?: number }
  ) {
    super(message);
    this.name = "ShiftError";
  }
}
