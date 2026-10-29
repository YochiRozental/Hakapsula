import { NextResponse } from "next/server";
import { approveCancellationRefund } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireAdminUser } from "@/lib/payments/flow";

/** מנהל מאשר חריג להזמנה שבוטלה בפחות מ-24 שעות לפני ההתחלה: החזר כספי, החזרת דקות, ואופציונלית ויתור על חוב */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const admin = await requireAdminUser();
  if ("response" in admin) return admin.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  try {
    const res = await approveCancellationRefund({
      appointmentId: id,
      adminId: admin.user.id,
      provider,
      waiveDebt: body?.waiveDebt === true,
    });
    return NextResponse.json({
      refundStatus: res.refund?.status ?? "NOTHING_TO_REFUND",
      minutesRestored: res.minutesRestored,
      creditedMinutes: res.creditedMinutes,
      debtWaived: res.debtWaived,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
