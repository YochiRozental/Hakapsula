import { prisma } from "@/lib/prisma";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";
import { BUSINESS_HOURS, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES } from "@/lib/business-rules";
import { BookingError } from "@/lib/booking-error";
import type { BookingSource, RoomKey } from "@/generated/prisma/client";

export { BookingError } from "@/lib/booking-error";

function validateTimeRange(startTime: Date, endTime: Date) {
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    throw new BookingError("תאריך/שעה לא תקינים");
  }
  if (endTime <= startTime) {
    throw new BookingError("שעת הסיום חייבת להיות אחרי שעת ההתחלה");
  }
  const durationMinutes = (endTime.getTime() - startTime.getTime()) / 60000;
  if (durationMinutes < MIN_DURATION_MINUTES) {
    throw new BookingError(`משך התור המינימלי הוא ${MIN_DURATION_MINUTES} דקות`);
  }
  if (durationMinutes > MAX_DURATION_MINUTES) {
    throw new BookingError(`משך התור המקסימלי הוא ${MAX_DURATION_MINUTES} דקות`);
  }
  if (startTime.getTime() < Date.now()) {
    throw new BookingError("לא ניתן לקבוע תור בזמן שכבר עבר");
  }
  if (
    startTime.getHours() < BUSINESS_HOURS.startHour ||
    endTime.getHours() > BUSINESS_HOURS.endHour ||
    (endTime.getHours() === BUSINESS_HOURS.endHour && endTime.getMinutes() > 0)
  ) {
    throw new BookingError(
      `ניתן לקבוע תורים בין השעות ${BUSINESS_HOURS.startHour}:00 ל-${BUSINESS_HOURS.endHour}:00 בלבד`
    );
  }
}

export async function findConflictingAppointments(
  roomKey: RoomKey,
  startTime: Date,
  endTime: Date,
  excludeAppointmentId?: string
) {
  const conflictingKeys = CONFLICTING_ROOM_KEYS[roomKey];
  return prisma.appointment.findMany({
    where: {
      id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
      status: "CONFIRMED",
      room: { key: { in: conflictingKeys } },
      startTime: { lt: endTime },
      endTime: { gt: startTime },
    },
    include: { room: true, user: true },
  });
}

export async function createAppointment(params: {
  userId: string;
  roomKey: RoomKey;
  startTime: Date;
  endTime: Date;
  notes?: string;
  source?: BookingSource;
}) {
  const { userId, roomKey, startTime, endTime, notes, source = "WEB" } = params;

  validateTimeRange(startTime, endTime);

  await ensureRooms();
  const room = await prisma.room.findUnique({ where: { key: roomKey } });
  if (!room || !room.active) {
    throw new BookingError("החדר המבוקש אינו זמין");
  }

  return prisma.$transaction(async (tx) => {
    const conflictingKeys = CONFLICTING_ROOM_KEYS[roomKey];
    const conflicts = await tx.appointment.findMany({
      where: {
        status: "CONFIRMED",
        room: { key: { in: conflictingKeys } },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
    });

    if (conflicts.length > 0) {
      throw new BookingError("החדר תפוס בטווח הזמן שנבחר, אנא בחר שעה אחרת");
    }

    return tx.appointment.create({
      data: {
        userId,
        roomId: room.id,
        startTime,
        endTime,
        notes,
        source,
      },
      include: { room: true, user: true },
    });
  });
}

export async function cancelAppointment(
  appointmentId: string,
  requestingUser: { id: string; role: string }
) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });
  if (!appointment) {
    throw new BookingError("התור לא נמצא");
  }
  if (requestingUser.role !== "ADMIN" && appointment.userId !== requestingUser.id) {
    throw new BookingError("אין הרשאה לבטל תור זה");
  }
  return prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: "CANCELLED" },
  });
}
