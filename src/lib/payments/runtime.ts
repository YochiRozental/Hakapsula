import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/lib/payments/config";
import { PrismaMockStore } from "@/lib/payments/mock-store";
import { PaymentConfigError, type PaymentProvider } from "@/lib/payments/provider";
import { isMockUserAllowed } from "@/lib/payments/mock-access";

/**
 * בניית ספק התשלום הפעיל, ללא תלות ב-Next.js או ב-Auth.js, כדי שגם שרת ה-IVR (תהליך Node נפרד) ישתמש באותו ספק ובאותן
 * הגנות. מחזיר null כשאין ספק תקף: ברירת המחדל בכל סביבה חיה. Mock עולה רק בתנאי ההפרדה של config.ts (sandbox מפורש,
 * דגל נפרד, לא production, מסד מקומי). מצב ה-Mock נשמר ב-PostgreSQL ולא בזיכרון התהליך.
 */
export function getRuntimeProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  try {
    return getPaymentProvider(env, {
      mockStore: new PrismaMockStore(prisma),
      // אכיפה בצד השרת על כל יצירת תשלום/חיוב של Mock באתר מותקן: רק מנהל או משתמש בדיקה מורשה (mock-access.ts)
      mockCustomerAllowed: async (customerRef) => {
        const user = await prisma.user.findUnique({ where: { id: customerRef }, select: { role: true, email: true } });
        return !!user && isMockUserAllowed(user, env);
      },
    });
  } catch (err) {
    if (err instanceof PaymentConfigError) return null;
    throw err;
  }
}
