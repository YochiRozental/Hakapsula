import { NextResponse } from "next/server";
import type { RoomKey } from "@/generated/prisma/client";
import { holdRoom } from "@/lib/payments/booking-payment";
import { errorResponse, getFlowProvider, notFound, requireBookingUser } from "@/lib/payments/flow";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";
import { WEB_BOOKING_DURATION_MINUTES } from "@/lib/slots";

/** יצירת החזקה זמנית (10 דקות) לחדר. אידמפוטנטי: אותה בקשה חוזרת מחזירה את אותה החזקה */
export async function POST(request: Request) {
  if (!getFlowProvider()) return notFound();
  const authed = await requireBookingUser();
  if ("response" in authed) return authed.response;

  const body = await request.json().catch(() => null);
  const roomKey = body?.roomKey as RoomKey | undefined;
  const start = new Date(body?.startTime);
  const end = new Date(body?.endTime);
  if (!roomKey || !CONFLICTING_ROOM_KEYS[roomKey] || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: "חסרים פרטים להחזקת החדר" }, { status: 400 });
  }
  if ((end.getTime() - start.getTime()) / 60000 !== WEB_BOOKING_DURATION_MINUTES) {
    return NextResponse.json({ error: "ניתן להזמין חדר לשעה אחת בלבד" }, { status: 400 });
  }

  try {
    const notes = typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined;
    const hold = await holdRoom({ userId: authed.user.id, roomKey, startTime: start, endTime: end, notes, source: "WEB" });
    return NextResponse.json(
      {
        appointmentId: hold.id,
        room: hold.room.key,
        startTime: hold.startTime,
        endTime: hold.endTime,
        holdExpiresAt: hold.holdExpiresAt,
      },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
