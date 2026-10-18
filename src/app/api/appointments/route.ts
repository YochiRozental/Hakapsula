import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createAppointment, BookingError } from "@/lib/booking";
import type { RoomKey } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getMissingBookingDetails } from "@/lib/profile";
import { WEB_BOOKING_DURATION_MINUTES } from "@/lib/slots";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const appointments = await prisma.appointment.findMany({
    where: { userId: session.user.id },
    include: { room: true },
    orderBy: { startTime: "desc" },
  });

  return NextResponse.json(appointments);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "יש להתחבר כדי לקבוע תור", code: "AUTH_REQUIRED" }, { status: 401 });
  }

  // פרטי החובה נבדקים מול מסד הנתונים (לא מול ה-session), כדי שלא ניתן לעקוף את הבדיקה
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) {
    return NextResponse.json({ error: "יש להתחבר כדי לקבוע תור", code: "AUTH_REQUIRED" }, { status: 401 });
  }
  const missing = getMissingBookingDetails(user);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "יש להשלים את פרטי החשבון לפני קביעת תור", code: "PROFILE_INCOMPLETE", missing },
      { status: 422 }
    );
  }
  if (user.status !== "APPROVED") {
    return NextResponse.json({ error: "החשבון שלך טרם אושר לקביעת תורים", code: "NOT_APPROVED" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const roomKey = body?.roomKey as RoomKey | undefined;
  const startTime = body?.startTime as string | undefined;
  const endTime = body?.endTime as string | undefined;
  const notes = body?.notes as string | undefined;

  if (!roomKey || !startTime || !endTime) {
    return NextResponse.json({ error: "חסרים פרטים לקביעת התור" }, { status: 400 });
  }

  const durationMinutes = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000;
  if (durationMinutes !== WEB_BOOKING_DURATION_MINUTES) {
    return NextResponse.json({ error: "ניתן להזמין חדר לשעה אחת בלבד" }, { status: 400 });
  }

  try {
    const appointment = await createAppointment({
      userId: user.id,
      roomKey,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      notes,
      source: "WEB",
    });
    return NextResponse.json(appointment, { status: 201 });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "שגיאה בקביעת התור" }, { status: 500 });
  }
}
