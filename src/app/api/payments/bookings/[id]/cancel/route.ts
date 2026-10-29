import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { cancelBooking } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/** ביטול החזקה/הזמנה: החזר אוטומטי רק לביטול 24 שעות ומעלה לפני ההתחלה. בעלים או מנהל בלבד */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  try {
    const result = await cancelBooking({
      appointmentId: id,
      requester: { id: session.user.id, role: session.user.role },
      provider,
      // חריג מנהל נתמך רק כשהמבקש מנהל (נאכף בשירות)
      adminException: body?.adminException === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
