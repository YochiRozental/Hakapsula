import { NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/**
 * קליטת התראות ספק. ללא סשן: האימות הוא חתימת ה-webhook בלבד, וגם אחריה הסטטוס נשלף מחדש מהספק.
 * כשאין ספק מוגדר (כל סביבה חיה כרגע) הנתיב מחזיר 404.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = getFlowProvider();
  const { provider: name } = await params;
  if (!provider || provider.name !== name) return notFound();

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  try {
    const result = await handlePaymentWebhook({ provider, rawBody, headers });
    // DEFERRED: התשלום עדיין לא ידוע אצלנו; 202 מבקש מהספק לנסות שוב
    return NextResponse.json({ outcome: result.outcome }, { status: result.outcome === "DEFERRED" ? 202 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
