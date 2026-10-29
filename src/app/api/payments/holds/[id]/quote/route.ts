import { NextResponse } from "next/server";
import { quoteHold } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireBookingUser } from "@/lib/payments/flow";

/** הצעת מחיר להחזקה: כמה דקות יינוכו מהיתרה וכמה ישולם בכסף. קריאה בלבד: לא מנכה ולא שומרת כלום */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!getFlowProvider()) return notFound();
  const authed = await requireBookingUser();
  if ("response" in authed) return authed.response;

  const { id } = await params;
  const useBalance = new URL(request.url).searchParams.get("useBalance") !== "false";
  try {
    return NextResponse.json(await quoteHold({ appointmentId: id, userId: authed.user.id, useBalance }));
  } catch (err) {
    return errorResponse(err);
  }
}
