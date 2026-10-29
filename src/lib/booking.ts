import { prisma } from "@/lib/prisma";
import { CONFLICTING_ROOM_KEYS, ROOM_LOCK_ZONE } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";
import { assertBookable } from "@/lib/opening-hours-db";
import { MIN_DURATION_MINUTES, MAX_DURATION_MINUTES } from "@/lib/business-rules";
import { BookingError } from "@/lib/booking-error";
import type { BookingSource, Prisma, RoomKey } from "@/generated/prisma/client";

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
}

/** משך החזקת חדר עד השלמת תשלום */
export const HOLD_DURATION_MINUTES = 10;
/** תקרה להחזקות פעילות במקביל למשתמש אחד (מניעת חסימת חדרים בהחזקות סרק). לא חל על מנהל */
export const MAX_ACTIVE_HOLDS_PER_USER = 3;

/**
 * הזמנה שחוסמת חדר: מאושרת, או החזקה שעדיין לא פגה. החזקה שפגה אינה חוסמת גם אם הניקוי טרם רץ —
 * התנאי נבדק מול הזמן עצמו ולא מול הסטטוס בלבד. כל שאילתת זמינות/התנגשות חייבת להשתמש בו.
 */
export function blockingAppointmentWhere(now: Date): Prisma.AppointmentWhereInput {
  return {
    OR: [{ status: "CONFIRMED" }, { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } }],
  };
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
      ...blockingAppointmentWhere(new Date()),
      id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
      room: { key: { in: conflictingKeys } },
      startTime: { lt: endTime },
      endTime: { gt: startTime },
    },
    include: { room: true, user: true },
  });
}

/** מרחב השמות של נעילות ה-advisory של יצירת הזמנות (הנעילה היא לפי זוג מספרים: מרחב, אזור) */
const APPOINTMENT_LOCK_NAMESPACE = 7301;

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
  // שבת סגורה לכולם (כולל מנהל) ושעות הפעילות נאכפות — לפני כל גישה למסד
  await assertBookable(startTime, endTime, source, userId);

  await ensureRooms();
  const room = await prisma.room.findUnique({ where: { key: roomKey } });
  if (!room || !room.active) {
    throw new BookingError("החדר המבוקש אינו זמין");
  }

  return prisma.$transaction(async (tx) => {
    // בלי נעילה שתי בקשות מקבילות יעברו שתיהן את בדיקת החפיפה. הנעילה משתחררת אוטומטית בסיום הטרנזקציה
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APPOINTMENT_LOCK_NAMESPACE}::int, ${ROOM_LOCK_ZONE[roomKey]}::int)`;
    const conflictingKeys = CONFLICTING_ROOM_KEYS[roomKey];
    const conflicts = await tx.appointment.findMany({
      where: {
        ...blockingAppointmentWhere(new Date()),
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
      // התגובה מוחזרת ללקוח — רק שדות לא רגישים (לעולם לא passwordHash, ת"ז, פרטי כרטיס)
      include: { room: true, user: { select: { id: true, name: true } } },
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
  // מופע של משמרת קבועה: שינוי וביטול מחייבים אישור מנהל במסלול המשמרות (כולל ההשפעה על החיוב), לא ביטול תור בודד
  if ((await prisma.shiftOccurrence.count({ where: { appointmentId } })) > 0) {
    throw new BookingError("זהו מופע של משמרת קבועה. שינוי או ביטול מחייבים בקשה ואישור מנהל במסך המשמרות");
  }
  // הזמנה ששולמה מקוונת (בכסף או מיתרת דקות) מבוטלת רק דרך מסלול הביטול עם החזר (payments/booking-payment), כדי שלא יאבדו כסף או דקות
  const paid = await prisma.payment.count({ where: { appointmentId, status: "SUCCEEDED" } });
  if (paid > 0 || appointment.paidFromBalanceMinutes > 0) {
    throw new BookingError("הזמנה ששולמה מבוטלת דרך מסלול הביטול עם החזר");
  }
  return prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: "CANCELLED" },
  });
}

/** נעילת ה-advisory של אזור החדר. תמיד הנעילה הראשונה בטרנזקציה, לפני נעילת שורות (סדר עקבי מונע deadlock) */
export async function lockRoomZone(tx: Pick<Prisma.TransactionClient, "$executeRaw">, roomKey: RoomKey) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APPOINTMENT_LOCK_NAMESPACE}::int, ${ROOM_LOCK_ZONE[roomKey]}::int)`;
}

/**
 * יוצר החזקה זמנית (PENDING_PAYMENT) של חדר ל-HOLD_DURATION_MINUTES. אותן בדיקות ואותה נעילה כמו createAppointment.
 * אידמפוטנטי: אם למשתמש כבר יש החזקה פעילה על אותו חדר ואותו טווח (רענון דף, לחיצה כפולה) היא מוחזרת כמות שהיא.
 */
export async function createBookingHold(params: {
  userId: string;
  roomKey: RoomKey;
  startTime: Date;
  endTime: Date;
  notes?: string;
  source?: BookingSource;
  now?: Date;
}) {
  const { userId, roomKey, startTime, endTime, notes, source = "WEB", now = new Date() } = params;

  validateTimeRange(startTime, endTime);
  await assertBookable(startTime, endTime, source, userId);

  await ensureRooms();
  const room = await prisma.room.findUnique({ where: { key: roomKey } });
  if (!room || !room.active) {
    throw new BookingError("החדר המבוקש אינו זמין");
  }

  return prisma.$transaction(async (tx) => {
    await lockRoomZone(tx, roomKey);
    const conflicts = await tx.appointment.findMany({
      where: {
        ...blockingAppointmentWhere(now),
        room: { key: { in: CONFLICTING_ROOM_KEYS[roomKey] } },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
      include: { room: true, user: { select: { id: true, name: true } } },
    });

    if (conflicts.length > 0) {
      const existing = conflicts[0];
      const isMyHold =
        conflicts.length === 1 &&
        existing.status === "PENDING_PAYMENT" &&
        existing.userId === userId &&
        // החזקה של מקור אחר (למשל החזקת לקוח מול הזמנת מנהל עבורו) היא התנגשות, לא "אותה בקשה חוזרת"
        existing.source === source &&
        existing.roomId === room.id &&
        existing.startTime.getTime() === startTime.getTime() &&
        existing.endTime.getTime() === endTime.getTime();
      if (isMyHold) return existing;
      throw new BookingError("החדר תפוס בטווח הזמן שנבחר, אנא בחר שעה אחרת");
    }

    if (source !== "ADMIN") {
      const active = await tx.appointment.count({
        where: { userId, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
      });
      if (active >= MAX_ACTIVE_HOLDS_PER_USER) {
        throw new BookingError("יש לך כבר מספר החזקות פעילות; השלם תשלום או המתן לפקיעתן");
      }
    }

    return tx.appointment.create({
      data: {
        userId,
        roomId: room.id,
        startTime,
        endTime,
        notes,
        source,
        status: "PENDING_PAYMENT",
        paymentStatus: "UNPAID",
        holdExpiresAt: new Date(now.getTime() + HOLD_DURATION_MINUTES * 60_000),
      },
      include: { room: true, user: { select: { id: true, name: true } } },
    });
  });
}
