import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { finalizePayment } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/**
 * מצב תשלום. כל קריאה מאמתת מול הספק בצד השרת (והיא זו שמאשרת את ההזמנה אם התשלום הצליח),
 * ולכן "דף החזרה" של הדפדפן לא קובע דבר. נגיש לבעל התשלום ולמנהל בלבד.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id }, select: { userId: true } });
  const isAdmin = session.user.role === "ADMIN";
  if (!payment || (!isAdmin && payment.userId !== session.user.id)) return notFound();

  try {
    const result = await finalizePayment({ paymentId: id, provider });
    const current = await prisma.payment.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        purpose: true,
        amountAgorot: true,
        appointment: { select: { id: true, status: true, paymentStatus: true } },
        hoursPackage: { select: { id: true, hours: true, minutesRemaining: true, expiresAt: true } },
      },
    });
    return NextResponse.json({
      outcome: result.outcome,
      paymentStatus: current.status,
      amountAgorot: current.amountAgorot,
      purpose: current.purpose,
      appointment: current.appointment,
      package: current.hoursPackage,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
