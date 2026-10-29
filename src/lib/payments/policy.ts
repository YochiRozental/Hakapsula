/** מדיניות ביטולים וזיכויים (פונקציות טהורות). הפעלתן בפועל בזרימת ההזמנות שייכת לשלב הבא */

export const CANCELLATION_REFUND_WINDOW_HOURS = 24;
export const CREDIT_VALIDITY_DAYS = 30;

/**
 * האם ביטול מזכה בהחזר אוטומטי. ביטול בתוך 24 שעות ממועד תחילת ההזמנה אינו מזכה, למעט חריג מנהל.
 * הנחה (לא נקבעה במפורש): ביטול בדיוק 24 שעות לפני ההתחלה עדיין מזכה.
 */
export function isAutoRefundEligible(params: { startTime: Date; now: Date; adminException?: boolean }): boolean {
  if (params.adminException) return true;
  const hoursUntilStart = (params.startTime.getTime() - params.now.getTime()) / 3_600_000;
  return hoursUntilStart >= CANCELLATION_REFUND_WINDOW_HOURS;
}

/** תוקף זיכוי שניתן במקום החזרת דקות מחבילה שפגה: 30 יום מרגע הענקתו */
export function creditExpiry(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + CREDIT_VALIDITY_DAYS * 24 * 3_600_000);
}
