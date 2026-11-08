import { NextResponse } from "next/server";
import { errorResponse, getFlowProvider, notFound, requireAdminAppointment } from "@/lib/payments/flow";
import { getHoldDetails } from "@/lib/payments/views";

/** מצב החזקה/הזמנה שנוצרה על ידי מנהל: אותם נתונים שדף הצ'קאאוט של לקוח מקבל, עבור הלקוח שנבחר */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!getFlowProvider()) return notFound();
  const { id } = await params;
  const authed = await requireAdminAppointment(id);
  if ("response" in authed) return authed.response;

  try {
    return NextResponse.json(await getHoldDetails(id, authed.userId));
  } catch (err) {
    return errorResponse(err);
  }
}
