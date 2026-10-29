/**
 * שער תשלום בטלפון. סגור כברירת מחדל: ללא IVR_PAYMENTS_ENABLED=true ה-IVR פועל בדיוק כמו קודם (הזמנה מאושרת מיד, בלי
 * תשלום). גם כשהוא פתוח, הזרימה פעילה רק אם יש ספק תשלום תקף בסביבה (כיום: Mock בסביבת sandbox מקומית בלבד).
 */
export function isIvrPaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.IVR_PAYMENTS_ENABLED === "true";
}
