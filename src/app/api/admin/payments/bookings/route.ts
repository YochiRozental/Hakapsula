import { NextResponse } from "next/server";
import type { RoomKey } from "@/generated/prisma/client";
import { createAdminBookingWithDebt } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireAdminUser } from "@/lib/payments/flow";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";

/** מנהל יוצר הזמנה מאושרת ללא תשלום, עם חוב פתוח. פעיל רק כשזרימת התשלום פעילה (sandbox מקומי) */
export async function POST(request: Request) {
  if (!getFlowProvider()) return notFound();
  const admin = await requireAdminUser();
  if ("response" in admin) return admin.response;

  const body = await request.json().catch(() => null);
  const roomKey = body?.roomKey as RoomKey | undefined;
  const start = new Date(body?.startTime);
  const end = new Date(body?.endTime);
  if (
    typeof body?.userId !== "string" ||
    !roomKey ||
    !CONFLICTING_ROOM_KEYS[roomKey] ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return NextResponse.json({ error: "חסרים פרטים" }, { status: 400 });
  }

  try {
    const { appointment, debt } = await createAdminBookingWithDebt({
      adminId: admin.user.id,
      userId: body.userId,
      roomKey,
      startTime: start,
      endTime: end,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return NextResponse.json({ appointmentId: appointment.id, debtId: debt?.id, debtAgorot: debt?.amountAgorot }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
