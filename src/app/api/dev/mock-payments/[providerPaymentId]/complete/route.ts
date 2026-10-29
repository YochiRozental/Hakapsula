import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { handlePaymentWebhook } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";

/**
 * כלי פיתוח בלבד: מדמה לקוח שסיים את עמוד התשלום של ספק ה-Mock (הצלחה/כישלון/ביטול), ואופציונלית שולח webhook חתום.
 * קיים רק כשהספק הפעיל הוא Mock (sandbox מקומי); בכל סביבה אחרת מחזיר 404. מחייב התחברות ובעלות על התשלום.
 */
export async function POST(request: Request, { params }: { params: Promise<{ providerPaymentId: string }> }) {
  const provider = getFlowProvider();
  if (!(provider instanceof MockPaymentProvider)) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const { providerPaymentId } = await params;
  const payment = await prisma.payment.findFirst({
    where: { provider: provider.name, providerPaymentId },
    select: { userId: true },
  });
  if (!payment || (session.user.role !== "ADMIN" && payment.userId !== session.user.id)) return notFound();

  const body = await request.json().catch(() => null);
  const outcome = body?.outcome === "failure" ? "failure" : body?.outcome === "cancel" ? "cancel" : "success";
  try {
    if (outcome === "cancel") await provider.cancelPayment(providerPaymentId);
    else await provider.completeCheckout(providerPaymentId, outcome);
    if (body?.sendWebhook) {
      const signed = provider.buildWebhook({
        eventId: `evt_${crypto.randomUUID()}`,
        type: "payment.updated",
        providerPaymentId,
      });
      const result = await handlePaymentWebhook({ provider, ...signed });
      return NextResponse.json({ completed: outcome, webhook: result.outcome });
    }
    return NextResponse.json({ completed: outcome });
  } catch (err) {
    return errorResponse(err);
  }
}
