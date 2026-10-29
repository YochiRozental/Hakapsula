import { NextResponse } from "next/server";
import { errorResponse, getFlowProvider, notFound, requireBookingUser } from "@/lib/payments/flow";
import { getHoldDetails } from "@/lib/payments/views";

/**
 * מצב החזקה/הזמנה של המשתמש: זמן פקיעה לפי השרת, מחיר, יתרה וחלוקת התשלום. קריאה בלבד.
 * מאפשר לדף התשלום להמשיך אחרי רענון, ולהציג תוצאה סופית רק לפי מה שנקבע בשרת.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!getFlowProvider()) return notFound();
  const authed = await requireBookingUser();
  if ("response" in authed) return authed.response;

  const { id } = await params;
  try {
    return NextResponse.json(await getHoldDetails(id, authed.user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
