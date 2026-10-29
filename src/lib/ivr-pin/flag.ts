/**
 * שער להגדרת הקוד הטלפוני באתר. סגור כברירת מחדל: ללא IVR_PIN_SETUP_ENABLED=true הנתיב והעמוד מחזירים 404 והכניסה
 * מ"הכרטיס שלי" אינה מוצגת. נפתח רק בהחלטה מפורשת, אחרי שהמיגרציה הוחלה בסביבה.
 */
export function isIvrPinSetupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.IVR_PIN_SETUP_ENABLED === "true";
}
