import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { cancelAppointment, BookingError } from "@/lib/booking";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const appointment = await cancelAppointment(id, session.user);
    return NextResponse.json(appointment);
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: "שגיאה בביטול ההזמנה" }, { status: 500 });
  }
}
