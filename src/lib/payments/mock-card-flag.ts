/**
 * שער לשמירת אמצעי תשלום מדומה באתר (בדיקות בלבד). סגור כברירת מחדל. גם כשהוא פתוח, הנתיבים והעמוד פעילים רק כשהספק
 * הפעיל הוא Mock בסביבת sandbox מקומית: בכל סביבה אחרת הם מחזירים 404. אין בו קליטת כרטיס אשראי כלשהי.
 */
export function isMockCardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOCK_SAVED_CARD_ENABLED === "true";
}
