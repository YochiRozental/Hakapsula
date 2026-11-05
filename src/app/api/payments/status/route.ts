import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getFlowProvider, notFound } from "@/lib/payments/flow";
import { isMockAccessRestricted, isMockUserAllowed } from "@/lib/payments/mock-access";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";

/**
 * שער ההפעלה של זרימת התשלום עבור הממשק. כשאין ספק תקף (כל סביבה חיה כיום) מחזיר 404, והממשק נשאר במסלול ההזמנה
 * הקיים. באתר מותקן עם Mock (PAYMENT_MOCK_ALLOW_DEPLOYED) הזרימה "קיימת" רק למשתמשי בדיקה מורשים; לכל השאר 404, כדי שלקוחות
 * רגילים ימשיכו בהזמנה הקיימת. sandbox=true רק כשהספק הוא Mock בסביבת פיתוח מקומית מורשית: זה מה שמאפשר להציג את פאנל התשלום המדומה.
 * אינו חושף שום הגדרה או סוד.
 */
export async function GET() {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  if (isMockAccessRestricted()) {
    const session = await auth();
    const user = session?.user ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, email: true } }) : null;
    if (!user || !isMockUserAllowed(user)) return notFound();
  }
  return NextResponse.json({ enabled: true, sandbox: provider instanceof MockPaymentProvider });
}
