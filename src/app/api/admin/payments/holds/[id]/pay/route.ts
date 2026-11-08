import { NextResponse } from "next/server";
import { startBookingPayment } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireAdminAppointment } from "@/lib/payments/flow";

/** מנהל פותח תשלום להחזקה שיצר, עבור הלקוח שנבחר. הסכום והחלק מהיתרה מחושבים בשרת, כמו אצל לקוח */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const { id } = await params;
  const authed = await requireAdminAppointment(id);
  if ("response" in authed) return authed.response;

  const body = await request.json().catch(() => null);
  try {
    const started = await startBookingPayment({
      appointmentId: id,
      userId: authed.userId,
      provider,
      useBalance: body?.useBalance !== false,
    });
    return NextResponse.json(started);
  } catch (err) {
    return errorResponse(err);
  }
}
