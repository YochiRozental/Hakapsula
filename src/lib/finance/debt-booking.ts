import { prisma } from "@/lib/prisma";
import type { RoomKey } from "@/generated/prisma/client";
import { blockingAppointmentWhere } from "@/lib/booking";
import { CONFLICTING_ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { assertBookable } from "@/lib/opening-hours-db";
import { BookingError } from "@/lib/booking-error";
import { jerusalemWallInstant } from "@/lib/jerusalem-time";
import { regularPriceAgorot } from "@/lib/payments/pricing";
import { createAdminBookingWithDebt } from "@/lib/payments/booking-payment";
import { writeAudit } from "@/lib/finance/audit";
import { FinanceError } from "@/lib/finance/errors";

/**
 * אישור הזמנה ללא תשלום מראש, עם חוב (מנהל בלבד). משתמש בשירות הקיים createAdminBookingWithDebt (אותה החזקה, אותה נעילת חדר,
 * אותה בדיקת התנגשות; אינו עוקף זמינות) ומוסיף: חישוב והצגת הסכום לפני האישור, אישור מפורש עם סכום החוב הצפוי (נבדק מחדש
 * בשרת), ורישום ביומן הביקורת באותה טרנזקציה שבה נוצרים ההזמנה והחוב. לקוח אינו יכול ליצור הזמנה עם חוב: אין נתיב כזה אלא למנהל.
 */

export interface DebtBookingInput {
  userId: string;
  roomKey: RoomKey;
  /** YYYY-MM-DD (שעון ירושלים) */
  date: string;
  /** HH:MM (שעון ירושלים) */
  start: string;
  durationMinutes: number;
}

function parse(input: DebtBookingInput) {
  if (!CONFLICTING_ROOM_KEYS[input.roomKey]) throw new FinanceError("חדר לא תקין", "INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new FinanceError("תאריך לא תקין", "INVALID");
  const m = /^(\d{2}):(\d{2})$/.exec(input.start);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new FinanceError("שעה לא תקינה", "INVALID");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes % 15 !== 0) {
    throw new FinanceError("משך ההזמנה חייב להיות מכפלה של 15 דקות", "INVALID");
  }
  const startTime = jerusalemWallInstant(input.date, Number(m[1]) * 60 + Number(m[2]));
  const endTime = new Date(startTime.getTime() + input.durationMinutes * 60_000);
  return { startTime, endTime };
}

export async function quoteDebtBooking(input: DebtBookingInput, now: Date = new Date()) {
  const { startTime, endTime } = parse(input);
  const customer = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, role: true, status: true } });
  if (!customer || customer.role !== "CLIENT") throw new FinanceError("הלקוח לא נמצא", "NOT_FOUND");
  if (customer.status !== "APPROVED") throw new FinanceError("לא ניתן לאשר הזמנה ללקוח שאינו מאושר או שנחסם", "CONFLICT");
  const conflicts = await prisma.appointment.count({
    where: {
      ...blockingAppointmentWhere(now),
      room: { key: { in: CONFLICTING_ROOM_KEYS[input.roomKey] } },
      startTime: { lt: endTime },
      endTime: { gt: startTime },
    },
  });
  // הזמנת מנהל פטורה משעות פעילות ומסלול, אך לא מיום סגור: מציגים זאת כבר בהצעה ולא רק בעת האישור
  let closedReason: string | null = null;
  try {
    await assertBookable(startTime, endTime, "ADMIN", input.userId);
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;
    closedReason = err.message;
  }
  const priceAgorot = regularPriceAgorot(input.durationMinutes);
  return {
    customer: { id: customer.id, name: customer.name },
    room: ROOM_LABELS[input.roomKey],
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    bookingAmountAgorot: priceAgorot,
    /** הזמנת מנהל ללא תשלום: כל הסכום הופך לחוב פתוח. אין שימוש ביתרות הלקוח */
    debtAgorot: priceAgorot,
    available: conflicts === 0 && !closedReason,
    unavailableReason: closedReason ?? (conflicts > 0 ? "החדר תפוס בטווח הזמן שנבחר" : null),
    inPast: startTime.getTime() < now.getTime(),
  };
}

export async function approveBookingWithDebt(input: DebtBookingInput & { adminId: string; reason?: string; confirm: unknown; expectedDebtAgorot: unknown }) {
  if (input.confirm !== true) throw new FinanceError("יש לאשר במפורש את יצירת ההזמנה והחוב", "INVALID");
  const quote = await quoteDebtBooking(input);
  if (typeof input.expectedDebtAgorot !== "number" || input.expectedDebtAgorot !== quote.debtAgorot) {
    throw new FinanceError("סכום החוב השתנה מאז שהוצג. יש לבדוק שוב", "CONFLICT", { debtAgorot: quote.debtAgorot });
  }
  const { startTime, endTime } = parse(input);
  const reason = input.reason?.trim().slice(0, 300) || "הזמנת מנהל ללא תשלום";
  const { appointment, debt } = await createAdminBookingWithDebt({
    adminId: input.adminId,
    userId: input.userId,
    roomKey: input.roomKey,
    startTime,
    endTime,
    reason,
    onCreated: async (tx, created) => {
      await writeAudit(tx, {
        action: "BOOKING_APPROVED_WITH_DEBT",
        adminId: input.adminId,
        userId: input.userId,
        entityType: "Debt",
        entityId: created.debtId,
        outcome: "ok",
        reason,
        after: { appointmentId: created.appointmentId, bookingAmountAgorot: quote.bookingAmountAgorot, debtAgorot: created.amountAgorot },
      });
    },
  });
  return { appointmentId: appointment.id, debtId: debt?.id ?? null, debtAgorot: debt?.amountAgorot ?? 0 };
}
