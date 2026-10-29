import { NextResponse } from "next/server";
import { startBookingPayment } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireBookingUser } from "@/lib/payments/flow";

/** פתיחת תשלום להחזקה. הסכום והחלק מהיתרה מחושבים בשרת. לחיצה כפולה מחזירה את אותו תשלום */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const authed = await requireBookingUser();
  if ("response" in authed) return authed.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  try {
    const started = await startBookingPayment({
      appointmentId: id,
      userId: authed.user.id,
      provider,
      // הלקוח רשאי רק לוותר על שימוש ביתרה; כמה לנכות וכמה לגבות נקבע בשרת
      useBalance: body?.useBalance !== false,
    });
    return NextResponse.json(started);
  } catch (err) {
    return errorResponse(err);
  }
}
