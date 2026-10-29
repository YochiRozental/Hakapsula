import type { MockStore } from "@/lib/payments/mock-store";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * בחירת ספק הסליקה לפי משתני סביבה. ברירת המחדל היא "אין ספק": בלי הגדרה מפורשת אין תשלומים.
 *
 * הפרדת Mock מסליקה אמיתית אינה נשענת על NODE_ENV בלבד. Mock עולה רק אם כל התנאים מתקיימים:
 *   1. PAYMENT_PROVIDER=mock
 *   2. PAYMENT_ENVIRONMENT=sandbox (הצהרה מפורשת שזו סביבת בדיקות)
 *   3. PAYMENT_MOCK_ENABLED=true (דגל נפרד, כדי ששינוי תצורה אחד לא יפעיל אותו בטעות)
 *   4. NODE_ENV אינו production
 *   5. DATABASE_URL מצביע למסד מקומי (כך Mock לא יכול לעבוד מול מסד חי כמו Neon)
 *   6. PAYMENT_WEBHOOK_SECRET מוגדר
 */

export interface PaymentEnv {
  NODE_ENV?: string;
  PAYMENT_PROVIDER?: string;
  PAYMENT_ENVIRONMENT?: string;
  PAYMENT_MOCK_ENABLED?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  DATABASE_URL?: string;
}

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MIN_WEBHOOK_SECRET_LENGTH = 16;

export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_DB_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertMockAllowed(env: PaymentEnv) {
  const problems: string[] = [];
  if (env.PAYMENT_ENVIRONMENT !== "sandbox") problems.push("PAYMENT_ENVIRONMENT חייב להיות sandbox");
  if (env.PAYMENT_MOCK_ENABLED !== "true") problems.push("PAYMENT_MOCK_ENABLED חייב להיות true");
  if (env.NODE_ENV === "production") problems.push("אסור בבניית production");
  if (!isLocalDatabaseUrl(env.DATABASE_URL)) problems.push("DATABASE_URL חייב להצביע למסד מקומי");
  if (!env.PAYMENT_WEBHOOK_SECRET || env.PAYMENT_WEBHOOK_SECRET.length < MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push(`PAYMENT_WEBHOOK_SECRET חסר או קצר מ-${MIN_WEBHOOK_SECRET_LENGTH} תווים`);
  }
  if (problems.length > 0) {
    // ההודעה כוללת רק שמות משתנים ולא ערכים (בלי חשיפת סודות או כתובת מסד)
    throw new PaymentConfigError(`ספק התשלום המדומה (mock) חסום: ${problems.join("; ")}`);
  }
}

/** מחזיר את הספק המוגדר, או זורק PaymentConfigError. אין יצירה אוטומטית של Mock */
export function getPaymentProvider(
  env: PaymentEnv = process.env,
  options: { mockStore?: MockStore } = {}
): PaymentProvider {
  const kind = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none") {
    throw new PaymentConfigError("לא הוגדר ספק תשלומים (PAYMENT_PROVIDER)");
  }
  if (kind === "mock") {
    assertMockAllowed(env);
    return new MockPaymentProvider(env.PAYMENT_WEBHOOK_SECRET!, options.mockStore);
  }
  if (kind === "payme") {
    // מכוון: אין מימוש עד שיכולות ה-API של PAYME יאומתו בתיעוד הרשמי
    throw new PaymentConfigError("ספק payme עדיין לא ממומש");
  }
  throw new PaymentConfigError(`ספק תשלומים לא מוכר: ${kind}`);
}
