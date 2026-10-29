import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/lib/payments/config";
import { PrismaMockStore } from "@/lib/payments/mock-store";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * בניית ספק התשלום הפעיל, ללא תלות ב-Next.js או ב-Auth.js, כדי שגם שרת ה-IVR (תהליך Node נפרד) ישתמש באותו ספק ובאותן
 * הגנות. מחזיר null כשאין ספק תקף: ברירת המחדל בכל סביבה חיה. Mock עולה רק בתנאי ההפרדה של config.ts (sandbox מפורש,
 * דגל נפרד, לא production, מסד מקומי). מצב ה-Mock נשמר ב-PostgreSQL ולא בזיכרון התהליך.
 */
export function getRuntimeProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  try {
    return getPaymentProvider(env, { mockStore: new PrismaMockStore(prisma) });
  } catch (err) {
    if (err instanceof PaymentConfigError) return null;
    throw err;
  }
}
