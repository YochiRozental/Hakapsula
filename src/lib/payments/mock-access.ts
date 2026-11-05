/**
 * הגבלת תשלומי דמה (Mock) למשתמשי בדיקה מורשים, בצד השרת. ההגבלה חלה רק כשה-Mock רץ על אתר מותקן
 * (PAYMENT_MOCK_ALLOW_DEPLOYED=true): בהדגמה מקומית אין הגבלה. מורשה: מנהל, או משתמש שכתובת האימייל שלו ברשימה
 * PAYMENT_MOCK_TEST_USERS (כתובות מופרדות בפסיקים, ללא הבחנה בין אותיות גדולות לקטנות). בלי רשימה — רק מנהלים.
 * האכיפה העיקרית בתוך ספק ה-Mock עצמו (כל יצירת תשלום או חיוב בודקים את הלקוח), כך שאין דרך עוקפת דרך נתיב API.
 */
/** מצופים: PAYMENT_PROVIDER, PAYMENT_MOCK_ALLOW_DEPLOYED, PAYMENT_MOCK_TEST_USERS */
export type MockAccessEnv = Record<string, string | undefined>;

export function isMockAccessRestricted(env: MockAccessEnv = process.env): boolean {
  return env.PAYMENT_PROVIDER?.trim().toLowerCase() === "mock" && env.PAYMENT_MOCK_ALLOW_DEPLOYED === "true";
}

export function mockTestUserEmails(env: MockAccessEnv = process.env): Set<string> {
  return new Set(
    (env.PAYMENT_MOCK_TEST_USERS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isMockUserAllowed(user: { role: string; email: string | null }, env: MockAccessEnv = process.env): boolean {
  if (!isMockAccessRestricted(env)) return true;
  if (user.role === "ADMIN") return true;
  return !!user.email && mockTestUserEmails(env).has(user.email.trim().toLowerCase());
}

export const MOCK_ACCESS_DENIED_MESSAGE = "תשלומי הדמה זמינים רק למשתמשי בדיקה מורשים";
