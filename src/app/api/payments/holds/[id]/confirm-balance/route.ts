import { NextResponse } from "next/server";
import { confirmBookingFromBalance } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireBookingUser } from "@/lib/payments/flow";

/** אישור הזמנה שמכוסה במלואה מיתרת חבילות/זיכויים. ההחזקה נדרשת; הניכוי והאישור אטומיים. גוף הבקשה אינו נקרא */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const authed = await requireBookingUser();
  if ("response" in authed) return authed.response;

  const { id } = await params;
  try {
    return NextResponse.json(await confirmBookingFromBalance({ appointmentId: id, userId: authed.user.id, provider }));
  } catch (err) {
    return errorResponse(err);
  }
}
