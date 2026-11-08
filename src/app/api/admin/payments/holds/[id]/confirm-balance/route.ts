import { NextResponse } from "next/server";
import { confirmBookingFromBalance } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireAdminAppointment } from "@/lib/payments/flow";

/** מנהל מאשר הזמנה שמכוסה במלואה מיתרת חבילות/זיכויים של הלקוח שנבחר, בלי תשלום בכסף */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const { id } = await params;
  const authed = await requireAdminAppointment(id);
  if ("response" in authed) return authed.response;

  try {
    return NextResponse.json(await confirmBookingFromBalance({ appointmentId: id, userId: authed.userId, provider }));
  } catch (err) {
    return errorResponse(err);
  }
}
