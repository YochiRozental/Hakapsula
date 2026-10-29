/**
 * שער משמרות קבועות. סגור כברירת מחדל: ללא SHIFTS_ENABLED=true אין הצגת אפשרות, אין יצירת משמרות ב-API, אין חיוב חודשי,
 * ו-Cron העסקי אינו פועל; ההזמנות הרגילות ממשיכות כרגיל. גם כשהדגל פתוח, הזרימה פעילה רק אם יש ספק תשלום תקף בסביבה
 * (כיום: Mock בסביבת sandbox מקומית בלבד), ולכן בסביבה חיה היא נשארת סגורה.
 */
export function isShiftsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHIFTS_ENABLED === "true";
}
