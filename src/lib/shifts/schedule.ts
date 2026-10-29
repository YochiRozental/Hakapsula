import type { PrismaClient, RoomKey } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { blockingAppointmentWhere, lockRoomZone } from "@/lib/booking";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";
import { hoursRejection, resolveDay } from "@/lib/opening-hours";
import { loadWindows, trackForUser } from "@/lib/opening-hours-db";
import type { PaymentProvider } from "@/lib/payments/provider";
import { findUsableCard } from "@/lib/payments/saved-methods";
import { isUniqueViolation } from "@/lib/payments/shared";
import { CONFLICTING_ROOM_KEYS, ROOM_KEYS } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";
import {
  billingMonths,
  groupByMonth,
  isShiftWindowId,
  monthAmountAgorot,
  occurrenceDatesBetween,
  occurrencePriceAgorot,
  occurrenceTimes,
  shiftEndDate,
  validateStartDate,
  SHIFT_WEEKDAYS,
  type ShiftWindowId,
} from "@/lib/shifts/calendar";
import { chargeShiftMonth } from "@/lib/shifts/billing";
import { ShiftError, type ShiftConflict } from "@/lib/shifts/errors";
import { MAX_OPEN_SHIFTS_PER_USER } from "@/lib/shifts/policy";

/**
 * תכנון ויצירה של משמרת קבועה. כל מופע הוא Appointment מאושר (source = SHIFT), ולכן מנגנון הזמינות וההתנגשויות הקיים
 * (blockingAppointmentWhere + נעילת ה-advisory של אזור החדר) חל עליו כמות שהוא: הזמנות רגילות, החזקות פעילות ומשמרות
 * אחרות חוסמות, והבדיקה והיצירה אטומיות תחת אותה נעילה. הבדיקה בממשק (preview) היא הצעה בלבד.
 */

export interface PlannedOccurrence {
  date: string;
  month: string;
  startTime: Date;
  endTime: Date;
  priceAgorot: number;
  /** יום שנסגר במפורש ע"י מנהל: המופע מדולג ואינו מחויב */
  skipReason?: string;
}

export interface ShiftPlan {
  occurrences: PlannedOccurrence[];
  conflicts: ShiftConflict[];
  startDate: string;
  endDate: string;
  priceAgorot: number;
  months: { month: string; count: number; amountAgorot: number; isFirst: boolean }[];
  firstChargeAgorot: number;
}

export interface PlanInput {
  userId: string;
  roomKey: RoomKey;
  weekday: number;
  windowId: string;
  startDate: string;
  now?: Date;
}

/** תכנון הלוח של משמרת חדשה: מאמת את הקלט, ומתכנן מהתאריך שנבחר ועד סוף שלושת החודשים. לא כולל זמינות החדר (ראו findRoomConflicts) */
export async function buildPlan(input: PlanInput, db: PrismaClient = defaultDb): Promise<ShiftPlan> {
  const { startDate, now = new Date() } = input;
  const startError = validateStartDate(startDate, jerusalemTodayIso(now));
  if (startError) throw new ShiftError(startError, "INVALID");
  const planned = await planOccurrences({ ...input, from: startDate, to: shiftEndDate(startDate) }, db);
  return { ...summarize(planned.occurrences, startDate, input.windowId as ShiftWindowId), conflicts: planned.conflicts };
}

/**
 * ליבת התכנון, גם למשמרת קיימת בשינוי מאושר (מופעים חדשים מתאריך מסוים ועד סוף התקופה המקורית): תאריכים ביום השבוע,
 * שעות פעילות, מסלול המשתמש, ימים סגורים. ללא בדיקת זמינות החדר.
 */
export async function planOccurrences(
  input: Omit<PlanInput, "startDate"> & { from: string; to: string },
  db: PrismaClient = defaultDb
): Promise<{ occurrences: PlannedOccurrence[]; conflicts: ShiftConflict[] }> {
  const { userId, roomKey, weekday, windowId, from, to } = input;

  if (!ROOM_KEYS.includes(roomKey)) throw new ShiftError("חדר לא קיים", "INVALID");
  if (!SHIFT_WEEKDAYS.includes(weekday as (typeof SHIFT_WEEKDAYS)[number])) throw new ShiftError("יום בשבוע לא תקין (אין משמרות בשבת)", "INVALID");
  if (!isShiftWindowId(windowId)) throw new ShiftError("משבצת שעות לא קיימת", "INVALID");

  await ensureRooms();
  const room = await db.room.findUnique({ where: { key: roomKey } });
  if (!room || !room.active) throw new ShiftError("החדר המבוקש אינו זמין", "INVALID");

  const track = await trackForUser(userId);
  if (!track) throw new ShiftError("יש להשלים מגדר בפרופיל כדי להזמין משמרת", "INVALID");

  const windows = await loadWindows();
  const price = occurrencePriceAgorot(windowId);
  const conflicts: ShiftConflict[] = [];
  const occurrences: PlannedOccurrence[] = occurrenceDatesBetween(from, to, weekday).map((date) => {
    const { startTime, endTime } = occurrenceTimes(date, windowId);
    const occ: PlannedOccurrence = { date, month: date.slice(0, 7), startTime, endTime, priceAgorot: price };
    const day = resolveDay(windows, date);
    if (day.closed) {
      // סגירה מפורשת של תאריך (חריג של מנהל): המופע מדולג ללא חיוב. יום שבועי סגור: אי אפשר לקבוע משמרת בו
      if (day.source === "exception") occ.skipReason = `יום סגור${day.note ? ` (${day.note})` : ""}`;
      else conflicts.push({ date, reason: "היום סגור לפי שעות הפעילות" });
      return occ;
    }
    const rejection = hoursRejection(windows, startTime, endTime, "SHIFT", track);
    if (rejection) conflicts.push({ date, reason: rejection });
    return occ;
  });

  if (occurrences.length === 0) throw new ShiftError("אין מופעים בתקופה שנבחרה", "INVALID");
  return { occurrences, conflicts };
}

function summarize(occurrences: PlannedOccurrence[], startDate: string, windowId: ShiftWindowId) {
  const live = occurrences.filter((o) => !o.skipReason);
  const byMonth = groupByMonth(live);
  const [firstMonth, ...rest] = billingMonths(startDate);
  const months = [firstMonth, ...rest].map((month) => {
    const count = byMonth.get(month)?.length ?? 0;
    return { month, count, amountAgorot: monthAmountAgorot(windowId, count), isFirst: month === firstMonth };
  });
  return {
    occurrences,
    startDate,
    endDate: shiftEndDate(startDate),
    priceAgorot: occurrencePriceAgorot(windowId),
    months,
    firstChargeAgorot: months[0].amountAgorot,
  };
}

type Db = Pick<PrismaClient, "appointment">;

/** התנגשויות עם הזמנות מאושרות / החזקות פעילות / משמרות אחרות בחדר (ובחדרים המתנגשים בו) */
export async function findRoomConflicts(db: Db, roomKey: RoomKey, occurrences: PlannedOccurrence[], now: Date): Promise<ShiftConflict[]> {
  const live = occurrences.filter((o) => !o.skipReason);
  if (live.length === 0) return [];
  const from = new Date(Math.min(...live.map((o) => o.startTime.getTime())));
  const to = new Date(Math.max(...live.map((o) => o.endTime.getTime())));
  const rows = await db.appointment.findMany({
    where: {
      ...blockingAppointmentWhere(now),
      room: { key: { in: CONFLICTING_ROOM_KEYS[roomKey] } },
      startTime: { lt: to },
      endTime: { gt: from },
    },
    select: { startTime: true, endTime: true },
  });
  return live
    .filter((o) => rows.some((r) => r.startTime < o.endTime && r.endTime > o.startTime))
    .map((o) => ({ date: o.date, reason: "החדר תפוס בשעות אלה" }));
}

/** הצעה לתצוגה מקדימה בלבד: תכנון + בדיקת זמינות, ללא נעילה וללא כתיבה */
export async function previewShift(input: PlanInput, db: PrismaClient = defaultDb): Promise<ShiftPlan> {
  const plan = await buildPlan(input, db);
  const roomConflicts = await findRoomConflicts(db, input.roomKey, plan.occurrences, input.now ?? new Date());
  return { ...plan, conflicts: [...plan.conflicts, ...roomConflicts] };
}

// ───────────────────────────── זכאות ─────────────────────────────

/** זכאות להזמנת משמרת, נבדקת בצד השרת מול המסד: אישור מפורש של מנהל, לקוח מאושר ולא חסום. חוב פתוח אינו חוסם */
export async function assertShiftEligible(userId: string, db: PrismaClient = defaultDb) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, canBookShifts: true, mustChangePassword: true },
  });
  if (!user || user.role !== "CLIENT") throw new ShiftError("רק לקוח רשאי להזמין משמרת", "FORBIDDEN");
  if (user.status === "BLOCKED") throw new ShiftError("החשבון חסום", "FORBIDDEN");
  if (user.status !== "APPROVED") throw new ShiftError("החשבון טרם אושר", "FORBIDDEN");
  if (!user.canBookShifts) throw new ShiftError("אין הרשאה להזמנת משמרות קבועות. ניתן לפנות להנהלה", "FORBIDDEN");
}

// ───────────────────────────── יצירה ─────────────────────────────

export type CreateShiftResult =
  | { status: "ACTIVE"; shiftId: string; firstChargeAgorot: number }
  /** החיוב הראשון במצב לא ידוע: המשבצות שמורות וממתינות לבירור מנהל. אין חיוב חוזר אוטומטי */
  | { status: "PENDING_REVIEW"; shiftId: string; firstChargeAgorot: number }
  /** החיוב הראשון נכשל: המשמרת לא אושרה והמשבצות שוחררו */
  | { status: "CHARGE_FAILED"; shiftId: string; failureCode?: string };

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

function resultFor(shift: { id: string; status: string; occurrencePriceAgorot: number }, firstChargeAgorot: number, failureCode?: string): CreateShiftResult {
  if (shift.status === "ACTIVE") return { status: "ACTIVE", shiftId: shift.id, firstChargeAgorot };
  if (shift.status === "PENDING") return { status: "PENDING_REVIEW", shiftId: shift.id, firstChargeAgorot };
  return { status: "CHARGE_FAILED", shiftId: shift.id, failureCode };
}

/**
 * יוצר משמרת: זכאות, אמצעי תשלום שמיש, בדיקה ויצירה אטומית של כל המופעים תחת נעילת החדר, ואז חיוב ראשון.
 * המשמרת מאושרת רק אחרי חיוב ראשון מוצלח. כישלון ודאי משחרר את המשבצות; מצב לא ידוע משאיר אותן שמורות לבירור מנהל.
 * אידמפוטנטי לפי clientKey (לחיצה כפולה/רענון מחזירים את אותה משמרת).
 */
export async function createShift(
  params: PlanInput & { clientKey: string; provider: PaymentProvider; createdById?: string; db?: PrismaClient }
): Promise<CreateShiftResult> {
  const { userId, roomKey, weekday, windowId, startDate, clientKey, provider, createdById = userId, now = new Date(), db = defaultDb } = params;

  await assertShiftEligible(userId, db);
  if (!CLIENT_KEY.test(clientKey)) throw new ShiftError("מפתח הבקשה אינו תקין", "INVALID");
  const idempotencyKey = `shift:${userId}:${clientKey}`;

  const replay = await db.shift.findUnique({ where: { idempotencyKey }, include: { charges: true } });
  if (replay) {
    const first = replay.charges.find((c) => c.isFirst);
    return resultFor(replay, first?.amountAgorot ?? 0, first?.failureCode ?? undefined);
  }

  const openShifts = await db.shift.count({ where: { userId, status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } } });
  if (openShifts >= MAX_OPEN_SHIFTS_PER_USER) throw new ShiftError("הגעת למספר המשמרות המרבי", "CONFLICT");

  // אין לאשר משמרת בלי אמצעי תשלום שמיש: בודקים לפני שנועלים משבצות
  const card = await findUsableCard(userId, provider, db);
  if (!card) throw new ShiftError("יש לשמור אמצעי תשלום באזור האישי לפני הזמנת משמרת", "NO_PAYMENT_METHOD");

  const plan = await buildPlan({ userId, roomKey, weekday, windowId, startDate, now }, db);
  if (plan.conflicts.length > 0) throw new ShiftError("לא ניתן ליצור את המשמרת בגלל התנגשויות", "CONFLICT", { conflicts: plan.conflicts });

  const room = await db.room.findUniqueOrThrow({ where: { key: roomKey } });
  let shiftId: string;
  let replayed = false;
  try {
    shiftId = await db.$transaction(async (tx) => {
      // אותה נעילה בדיוק כמו createAppointment/החזקות: חדרים מתנגשים חולקים אזור, ולכן הבדיקה והיצירה מסודרות בטור
      await lockRoomZone(tx, roomKey);
      // בקשה מקבילה עם אותו מפתח (לחיצה כפולה) שהקדימה אותנו: זו אותה בקשה, לא התנגשות
      const earlier = await tx.shift.findUnique({ where: { idempotencyKey }, select: { id: true } });
      if (earlier) {
        replayed = true;
        return earlier.id;
      }
      const conflicts = await findRoomConflicts(tx, roomKey, plan.occurrences, now);
      if (conflicts.length > 0) throw new ShiftError("החדר תפוס באחד או יותר מהמופעים", "CONFLICT", { conflicts });

      const shift = await tx.shift.create({
        data: {
          userId,
          roomId: room.id,
          weekday,
          windowId,
          startDate,
          endDate: plan.endDate,
          status: "PENDING",
          paymentMethodId: card.id,
          occurrencePriceAgorot: plan.priceAgorot,
          idempotencyKey,
          createdById,
        },
      });
      for (const occ of plan.occurrences) {
        if (occ.skipReason) {
          await tx.shiftOccurrence.create({
            data: { shiftId: shift.id, date: occ.date, month: occ.month, startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, status: "SKIPPED_CLOSED_DAY", statusNote: occ.skipReason },
          });
          continue;
        }
        const appointment = await tx.appointment.create({
          data: { userId, roomId: room.id, startTime: occ.startTime, endTime: occ.endTime, status: "CONFIRMED", source: "SHIFT", notes: "משמרת קבועה" },
        });
        await tx.shiftOccurrence.create({
          data: { shiftId: shift.id, date: occ.date, month: occ.month, startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, appointmentId: appointment.id },
        });
      }
      return shift.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // בקשה מקבילה עם אותו מפתח הקדימה אותנו
      const raced = await db.shift.findUnique({ where: { idempotencyKey }, include: { charges: true } });
      if (raced) return resultFor(raced, raced.charges.find((c) => c.isFirst)?.amountAgorot ?? 0);
    }
    throw err;
  }

  if (replayed) {
    const existing = await db.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { charges: true } });
    return resultFor(existing, existing.charges.find((c) => c.isFirst)?.amountAgorot ?? 0, existing.charges.find((c) => c.isFirst)?.failureCode ?? undefined);
  }

  // חיוב ראשון, מיד: רק החודש שבו המשמרת מתחילה, ורק המופעים שנותרו בו
  const [firstMonth] = billingMonths(startDate);
  const charge = await chargeShiftMonth({ shiftId, month: firstMonth, provider, isFirst: true, now, db });

  if (charge.outcome === "PAID" || charge.outcome === "NOTHING_DUE" || charge.outcome === "ALREADY_PAID") {
    await db.shift.updateMany({ where: { id: shiftId, status: "PENDING" }, data: { status: "ACTIVE" } });
    return { status: "ACTIVE", shiftId, firstChargeAgorot: charge.amountAgorot ?? 0 };
  }
  if (charge.outcome === "FAILED") {
    await abortPendingShift(db, shiftId, "first_charge_failed", now);
    return { status: "CHARGE_FAILED", shiftId, failureCode: charge.failureCode };
  }
  // UNKNOWN / IN_PROGRESS / NEEDS_REVIEW: נשאר PENDING והמשבצות שמורות עד בירור
  return { status: "PENDING_REVIEW", shiftId, firstChargeAgorot: charge.amountAgorot ?? 0 };
}

/** משחרר משמרת שלא אושרה: מבטל את הזמנות המופעים, מסמן את המופעים והמשמרת כמבוטלים. לא מוחק היסטוריה */
export async function abortPendingShift(db: PrismaClient, shiftId: string, reason: string, now: Date) {
  await db.$transaction(async (tx) => {
    const occurrences = await tx.shiftOccurrence.findMany({ where: { shiftId, status: "SCHEDULED" } });
    const appointmentIds = occurrences.map((o) => o.appointmentId).filter((x): x is string => !!x);
    await tx.appointment.updateMany({ where: { id: { in: appointmentIds }, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
    await tx.shiftOccurrence.updateMany({ where: { shiftId, status: "SCHEDULED" }, data: { status: "CANCELLED", statusNote: reason } });
    await tx.shift.updateMany({ where: { id: shiftId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason } });
  });
}
