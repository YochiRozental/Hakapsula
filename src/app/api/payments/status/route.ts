import { NextResponse } from "next/server";
import { getFlowProvider, notFound } from "@/lib/payments/flow";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";

/**
 * שער ההפעלה של זרימת התשלום עבור הממשק. כשאין ספק תקף (כל סביבה חיה כיום) מחזיר 404, והממשק נשאר במסלול ההזמנה
 * הקיים. sandbox=true רק כשהספק הוא Mock בסביבת פיתוח מקומית מורשית: זה מה שמאפשר להציג את פאנל התשלום המדומה.
 * אינו חושף שום הגדרה או סוד.
 */
export async function GET() {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  return NextResponse.json({ enabled: true, sandbox: provider instanceof MockPaymentProvider });
}
