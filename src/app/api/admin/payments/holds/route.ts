import { NextResponse } from "next/server";
import type { RoomKey } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { holdRoom } from "@/lib/payments/booking-payment";
import {
  errorResponse,
  getFlowProvider,
  notFound,
  requireAdminUser,
} from "@/lib/payments/flow";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";

/**
 * מנהל יוצר החזקה זמנית (10 דקות) לחדר, עבור לקוח קיים שנבחר — כצעד ראשון הזמנת קליניקה ידנית שממשיכה
 * לתשלום (לא תור מאושר מיד). משך גמיש (בניגוד להזמנת לקוח רגילה שמוגבלת לשעה), כפי שהטופס הידני מאפשר.
 */
export async function POST(request: Request) {
  if (!getFlowProvider()) return notFound();
  const admin = await requireAdminUser();
  if ("response" in admin) return admin.response;

  const body = await request.json().catch(() => null);
  const userId = body?.userId as string | undefined;
  const roomKey = body?.roomKey as RoomKey | undefined;
  const start = new Date(body?.startTime);
  const end = new Date(body?.endTime);
  if (
    typeof userId !== "string" ||
    !userId ||
    !roomKey ||
    !CONFLICTING_ROOM_KEYS[roomKey] ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return NextResponse.json(
      { error: "חסרים פרטים לקביעת התור" },
      { status: 400 },
    );
  }

  const customer = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!customer)
    return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });

  try {
    const notes =
      typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined;
    const hold = await holdRoom({
      userId,
      roomKey,
      startTime: start,
      endTime: end,
      notes,
      source: "ADMIN",
    });
    return NextResponse.json(
      {
        appointmentId: hold.id,
        room: hold.room.key,
        startTime: hold.startTime,
        endTime: hold.endTime,
        holdExpiresAt: hold.holdExpiresAt,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
