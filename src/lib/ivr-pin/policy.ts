/**
 * מדיניות הקוד הטלפוני: מקום אחד לכל הערכים, כדי שאפשר יהיה לשנות אותם בעתיד בלי לחפש בקוד.
 * מדיניות התחלתית שאושרה: עד 5 ניסיונות, חסימה ל-15 דקות, איפוס המונה אחרי אימות מוצלח.
 */

export interface ThrottlePolicy {
  /** מספר הניסיונות המרבי בחלון לפני חסימה. הניסיון האחרון המותר הוא האחרון: אחריו (אם נכשל) החסימה מתחילה */
  maxAttempts: number;
  blockMinutes: number;
}

export interface GlobalThrottlePolicy {
  /** כמה כשלונות אימות בכל המערכת בחלון אחד עד שהאימות מושבת זמנית לכולם */
  maxFailuresPerWindow: number;
  windowMinutes: number;
  blockMinutes: number;
}

export const IVR_PIN_POLICY = {
  /** אורך הקוד: ארבע ספרות בדיוק */
  pinLength: 4,
  /** אימות קוד (IVR והמשך עתידי לפעולות כספיות): לפי משתמש */
  verify: { maxAttempts: 5, blockMinutes: 15 } satisfies ThrottlePolicy,
  /** הרשאה לפעולה כספית אחרי אימות קוד: חד-פעמית ובת-חיים קצרה (שניות) */
  authorization: { ttlSeconds: 60 },
  /** הגדרה/שינוי קוד באתר (כולל ניסיונות סיסמה לאימות מחדש): לפי משתמש */
  setup: { maxAttempts: 5, blockMinutes: 15 } satisfies ThrottlePolicy,
  /**
   * הגנה מפני ניסיונות המוניים על משתמשים שונים. סף גבוה בכוונה כדי שתוקף לא יוכל בקלות להשבית את האימות לכולם:
   * מעבר לסף האימות מושבת זמנית (UNAVAILABLE) ולא מתאפשר ניחוש נוסף.
   */
  global: { maxFailuresPerWindow: 200, windowMinutes: 10, blockMinutes: 5 } satisfies GlobalThrottlePolicy,
} as const;

export type IvrPinPolicy = typeof IVR_PIN_POLICY;

export const PIN_PATTERN = /^\d{4}$/;
export const isValidPinFormat = (value: unknown): value is string => typeof value === "string" && PIN_PATTERN.test(value);
