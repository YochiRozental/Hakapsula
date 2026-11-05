import type { PrismaClient, Shift, ShiftCharge, ShiftOccurrence } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { lockRoomZone } from "@/lib/booking";
import { jerusalemTodayIso, jerusalemWallInstant } from "@/lib/jerusalem-time";
import { writeAudit } from "@/lib/finance/audit";
import type { PaymentProvider } from "@/lib/payments/provider";
import { ROOM_KEYS } from "@/lib/rooms";
import {
  addDays,
  billingDueDates,
  billingMonths,
  parseIso,
  periodKeyOf,
  SHIFT_WEEKDAYS,
} from "@/lib/shifts/calendar";
import { requireActiveWindow } from "@/lib/shifts/windows-db";
import { chargeShiftMonth, grantMakeupCredits, graceDeadline, refundChargeAmount, type ChargeResult } from "@/lib/shifts/billing";
import { createAppointment } from "@/lib/booking";
import { lockUserBalances } from "@/lib/payments/shared";
import { BookingError } from "@/lib/booking-error";
import type { RoomKey } from "@/generated/prisma/client";
import { ShiftError } from "@/lib/shifts/errors";
import { CHARGE_CLAIM_TTL_MS, MAX_NOTE_LENGTH, MAX_REASON_LENGTH } from "@/lib/shifts/policy";
import { abortPendingShift, findRoomConflicts, planOccurrences } from "@/lib/shifts/schedule";
import { isUniqueViolation } from "@/lib/payments/shared";

/**
 * מחזור החיים של משמרת אחרי היצירה: זכאות, השעיה וחידוש, בירור חיוב לא ידוע, תשלום ידני, סגירת יום ביוזמת ההנהלה
 * (שעה חלופית ללקוח), ובקשות שינוי/ביטול.
 * כל פעולה כאן היא פעולת מנהל (או בקשת לקוח שאינה משנה דבר עד אישור) ונאכפת בשרת מול המסד.
 */

async function assertAdmin(db: PrismaClient, adminId: string) {
  const admin = await db.user.findUnique({ where: { id: adminId }, select: { role: true } });
  if (admin?.role !== "ADMIN") throw new ShiftError("פעולה למנהל בלבד", "FORBIDDEN");
}

const clip = (value: string | undefined | null, max: number) => value?.trim().slice(0, max) || null;

// ───────────────────────────── זכאות ─────────────────────────────

export async function setShiftEligibility(params: { adminId: string; userId: string; allowed: boolean; now?: Date; db?: PrismaClient }) {
  const { adminId, userId, allowed, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user || user.role !== "CLIENT") throw new ShiftError("הלקוח לא נמצא", "NOT_FOUND");
  await db.user.update({ where: { id: userId }, data: { canBookShifts: allowed, shiftEligibilityUpdatedAt: now, shiftEligibilityUpdatedById: adminId } });
  return { userId, canBookShifts: allowed };
}

// ───────────────────────────── השעיה וחידוש ─────────────────────────────

const UNPAID = ["FAILED", "UNKNOWN", "PENDING"] as const;

/**
 * חידוש משמרת מושעית אחרי הסדרת חוב. המשמרת חוזרת לפעילות רק אם כל חיוביה שולמו/אופסו, או שהמנהל ויתר במפורש
 * (waiveUnpaid) על החיובים שנותרו: אין חידוש שקט שמתעלם מחוב.
 */
export async function resumeShift(params: { shiftId: string; adminId: string; waiveUnpaid?: boolean; note?: string; now?: Date; db?: PrismaClient }) {
  const { shiftId, adminId, waiveUnpaid = false, note, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const shift = await db.shift.findUnique({ where: { id: shiftId }, include: { charges: true } });
  if (!shift) throw new ShiftError("המשמרת לא נמצאה", "NOT_FOUND");
  if (shift.status !== "SUSPENDED") throw new ShiftError("ניתן לחדש רק משמרת מושעית", "CONFLICT");

  const unpaid = shift.charges.filter((c) => (UNPAID as readonly string[]).includes(c.status));
  if (unpaid.length > 0 && !waiveUnpaid) {
    throw new ShiftError("יש חיובים שלא הוסדרו. יש להסדיר אותם, או לוותר עליהם במפורש בחידוש", "CONFLICT");
  }
  await db.$transaction([
    ...unpaid.map((c) =>
      db.shiftCharge.update({ where: { id: c.id }, data: { status: "WAIVED", resolvedById: adminId, note: clip(`waived_on_resume${note ? `: ${note}` : ""}`, MAX_NOTE_LENGTH), graceUntil: null, claimedAt: null } })
    ),
    db.shift.update({
      where: { id: shiftId },
      data: { status: "ACTIVE", resumedAt: now, resumedById: adminId, suspendedAt: null, suspensionReason: null },
    }),
  ]);
  return { shiftId, waived: unpaid.length };
}

/** השעיה ידנית ע"י מנהל. המשבצות נשמרות והמשמרת אינה מתבטלת */
export async function suspendShiftManually(params: { shiftId: string; adminId: string; reason: string; now?: Date; db?: PrismaClient }) {
  const { shiftId, adminId, reason, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const { count } = await db.shift.updateMany({
    where: { id: shiftId, status: "ACTIVE" },
    data: { status: "SUSPENDED", suspendedAt: now, suspensionReason: `manual:${clip(reason, MAX_NOTE_LENGTH) ?? ""}` },
  });
  if (count === 0) throw new ShiftError("ניתן להשעות רק משמרת פעילה", "CONFLICT");
}

/** ניסיון חיוב חוזר ע"י מנהל (אחרי כישלון ודאי, גם אחרי תקופת החסד). לא חל על מצב "לא ידוע" */
export async function retryChargeAsAdmin(params: { chargeId: string; adminId: string; provider: PaymentProvider; now?: Date; db?: PrismaClient }): Promise<ChargeResult> {
  const { chargeId, adminId, provider, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const charge = await db.shiftCharge.findUnique({ where: { id: chargeId }, include: { shift: true } });
  if (!charge) throw new ShiftError("החיוב לא נמצא", "NOT_FOUND");
  if (charge.status === "UNKNOWN") throw new ShiftError("מצב החיוב לא ידוע. יש לברר אותו לפני כל ניסיון חוזר", "CONFLICT");
  if (charge.status !== "FAILED") throw new ShiftError("ניתן לנסות שוב רק חיוב שנכשל", "CONFLICT");
  if (charge.shift.paymentMode === "MANUAL") throw new ShiftError("במשמרת בתשלום ידני אין חיוב אוטומטי. יש לתעד את התשלום שהתקבל", "CONFLICT");
  // משמרת מושעית אינה פעילה לחיוב רגיל: ניסיון מנהל מכוון מחייב אותה במפורש. ההשעיה נשארת: חידוש הוא החלטה נפרדת
  // (resumeShift) ולא תוצר לוואי של ניסיון חיוב מוצלח
  if (charge.shift.status === "SUSPENDED") {
    await db.shift.update({ where: { id: charge.shiftId }, data: { status: "ACTIVE" } });
    try {
      return await chargeShiftMonth({ shiftId: charge.shiftId, month: charge.month, provider, retry: true, now, db });
    } finally {
      await db.shift.updateMany({ where: { id: charge.shiftId, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
    }
  }
  return chargeShiftMonth({ shiftId: charge.shiftId, month: charge.month, provider, retry: true, now, db });
}

/**
 * בירור ידני של חיוב במצב "לא ידוע": המנהל קובע, לפי בדיקה מול הספק, האם החיוב בוצע. בלי בירור כזה המערכת לא תחייב שוב.
 */
export async function resolveUnknownCharge(params: { chargeId: string; adminId: string; outcome: "PAID" | "NOT_CHARGED"; note?: string; now?: Date; db?: PrismaClient }) {
  const { chargeId, adminId, outcome, note, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const charge = await db.shiftCharge.findUnique({ where: { id: chargeId }, include: { shift: true } });
  if (!charge) throw new ShiftError("החיוב לא נמצא", "NOT_FOUND");
  if (charge.status !== "UNKNOWN") throw new ShiftError("החיוב אינו במצב לא ידוע", "CONFLICT");
  const text = clip(note, MAX_NOTE_LENGTH);

  if (outcome === "PAID") {
    await db.$transaction([
      ...(charge.paymentId ? [db.payment.updateMany({ where: { id: charge.paymentId, status: { not: "SUCCEEDED" } }, data: { status: "SUCCEEDED", paidAt: now } })] : []),
      db.shiftCharge.update({ where: { id: chargeId }, data: { status: "PAID", paidAt: now, resolvedById: adminId, note: text, claimedAt: null, failureCode: null, graceUntil: null } }),
    ]);
    if (charge.isFirst && charge.shift.status === "PENDING") {
      const { count } = await db.shift.updateMany({ where: { id: charge.shiftId, status: "PENDING" }, data: { status: "ACTIVE" } });
      if (count === 1) await grantMakeupCredits(db, now, { shiftId: charge.shiftId });
    }
    return { chargeId, status: "PAID" as const };
  }

  if (charge.paymentId) await db.payment.updateMany({ where: { id: charge.paymentId, status: "PENDING" }, data: { status: "FAILED", failureCode: "manual_not_charged" } });
  await db.shiftCharge.update({
    where: { id: chargeId },
    data: { status: "FAILED", failureCode: "manual_not_charged", resolvedById: adminId, note: text, claimedAt: null, graceUntil: charge.graceUntil ?? graceDeadline(now) },
  });
  if (charge.isFirst && charge.shift.status === "PENDING") await abortPendingShift(db, charge.shiftId, "first_charge_failed", now);
  return { chargeId, status: "FAILED" as const };
}

// ───────────────────────────── התאמת חיוב למופעים שהוסרו ─────────────────────────────

export interface AdjustSummary {
  refundedAgorot: number;
  creditedAgorot: number;
  pendingReview: number;
  refundFailures: number;
}

/**
 * מתאים את החיוב החודשי למופעים שהוסרו (סגירת יום / ביטול מאושר). אידמפוטנטי: מופע שכבר הותאם (refundedAgorot > 0)
 * אינו מטופל שוב.
 *  - חיוב ששולם: החזר חלקי דרך הספק (בביטול מאושר רק אם המנהל ביקש refundPaid)
 *  - חיוב שנכשל / שטרם נשלח: הסכום והמספר מופחתים (ואם מתאפס, החיוב מאופס)
 *  - חיוב במצב לא ידוע / בתהליך: לא נוגעים; המופע נשאר לא מותאם, והרצה חוזרת אחרי הבירור תטפל בו
 */
async function adjustChargesForRemovedOccurrences(
  db: PrismaClient,
  provider: PaymentProvider,
  occurrences: ShiftOccurrence[],
  opts: { refundPaid: boolean; reason: string; actorId: string }
): Promise<AdjustSummary> {
  const summary: AdjustSummary = { refundedAgorot: 0, creditedAgorot: 0, pendingReview: 0, refundFailures: 0 };
  for (const occ of occurrences) {
    if (occ.refundedAgorot > 0 || occ.priceAgorot === 0) continue;
    const charge = await db.shiftCharge.findUnique({ where: { shiftId_month: { shiftId: occ.shiftId, month: occ.month } } });
    if (!charge) continue;

    if (charge.status === "PAID") {
      if (!opts.refundPaid) continue;
      const refunded = await refundChargeAmount({ db, provider, chargeId: charge.id, amountAgorot: occ.priceAgorot, key: `shiftremoval:${occ.id}`, reason: opts.reason, createdById: opts.actorId });
      if (refunded > 0) {
        await db.shiftOccurrence.update({ where: { id: occ.id }, data: { refundedAgorot: refunded } });
        summary.refundedAgorot += refunded;
      } else summary.refundFailures++;
      continue;
    }
    if (charge.status === "FAILED" || (charge.status === "PENDING" && !charge.claimedAt)) {
      const count = Math.max(0, charge.occurrenceCount - 1);
      const amount = Math.max(0, charge.amountAgorot - occ.priceAgorot);
      await db.$transaction([
        db.shiftCharge.update({
          where: { id: charge.id },
          data: count === 0 ? { amountAgorot: 0, occurrenceCount: 0, status: "WAIVED", note: "all_occurrences_removed", graceUntil: null } : { amountAgorot: amount, occurrenceCount: count },
        }),
        db.shiftOccurrence.update({ where: { id: occ.id }, data: { refundedAgorot: occ.priceAgorot } }),
      ]);
      summary.creditedAgorot += occ.priceAgorot;
      continue;
    }
    if (charge.status === "UNKNOWN" || charge.status === "PENDING") summary.pendingReview++;
  }
  return summary;
}

// ───────────────────────────── סגירת יום ביוזמת ההנהלה ─────────────────────────────

export interface DayClosureSummary {
  date: string;
  /** מופעים שדולגו וזכאים לשעה חלופית */
  skipped: number;
  /** כמה זכאויות לשעה חלופית פתוחות (OWED) נוצרו או כבר קיימות ליום זה */
  makeupOwed: number;
  /** דקות הזיכוי שניתנו בהרצה זו (משך המפגשים שבוטלו, למשמרות פעילות) */
  creditedMinutes: number;
}

/**
 * סגירה מפורשת של תאריך ע"י ההנהלה משפיעה על מופעי משמרות באותו יום: המופע מדולג, הזמנתו מבוטלת והחדר מתפנה, והלקוח זכאי
 * לשעה חלופית (makeupStatus = OWED, מתואמת ע"י מנהל). אין החזר כספי ואין הפחתת חיוב: המחיר החודשי קבוע והחיובים אינם
 * משתנים. שינוי רגיל בשעות הפעילות אינו קורא לפונקציה הזו ואינו מבטל דבר. אידמפוטנטי: הרצה חוזרת אינה יוצרת זכאות כפולה.
 * ההיסטוריה נשמרת (שום שורה אינה נמחקת).
 */
export async function applyDayClosure(params: { date: string; adminId: string; now?: Date; db?: PrismaClient }): Promise<DayClosureSummary> {
  const { date, adminId, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  if (!parseIso(date)) throw new ShiftError("תאריך לא תקין", "INVALID");

  const live = await db.shiftOccurrence.findMany({
    where: { date, status: "SCHEDULED", shift: { status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } } },
  });
  let skipped = 0;
  for (const occ of live) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.shiftOccurrence.updateMany({
        where: { id: occ.id, status: "SCHEDULED" },
        data: { status: "SKIPPED_CLOSED_DAY", statusNote: `closed_day:${date}`, makeupStatus: "OWED", makeupUpdatedAt: now },
      });
      if (count === 1 && occ.appointmentId) await tx.appointment.updateMany({ where: { id: occ.appointmentId, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
      skipped += count;
    });
  }
  const credited = await grantMakeupCredits(db, now, { date });
  const makeupOwed = await db.shiftOccurrence.count({ where: { date, status: "SKIPPED_CLOSED_DAY", makeupStatus: "OWED" } });
  return { date, skipped, makeupOwed, creditedMinutes: credited.minutes };
}

// ───────────────────────────── שעות חלופיות ─────────────────────────────

/**
 * ויתור מפורש של מנהל על שעה חלופית: מאפס את היתרה שטרם נוצלה (דקות שכבר נוצלו נשארות). חל רק על מפגש שדולג בגלל סגירה.
 * ללא השפעה כספית ובלי שינוי בחיובי המשמרת. נרשם ביומן הביקורת. אי אפשר לבטל ויתור.
 */
export async function waiveOccurrenceMakeup(params: { occurrenceId: string; adminId: string; note?: string; now?: Date; db?: PrismaClient }) {
  const { occurrenceId, adminId, note, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const occ = await db.shiftOccurrence.findUnique({ where: { id: occurrenceId }, include: { shift: { select: { userId: true } } } });
  if (!occ || occ.makeupStatus === null) throw new ShiftError("אין זכאות לשעה חלופית במופע זה", "NOT_FOUND");
  if (occ.makeupStatus === "WAIVED") throw new ShiftError("כבר בוצע ויתור על השעה החלופית", "CONFLICT");
  const text = clip(note, MAX_NOTE_LENGTH);
  const waivedMinutes = await db.$transaction(async (tx) => {
    await lockUserBalances(tx, occ.shift.userId);
    let remaining = 0;
    if (occ.makeupCreditId) {
      const credit = await tx.credit.findUnique({ where: { id: occ.makeupCreditId } });
      remaining = credit?.minutesRemaining ?? 0;
      if (credit) await tx.credit.update({ where: { id: credit.id }, data: { minutesRemaining: 0 } });
    }
    const { count } = await tx.shiftOccurrence.updateMany({ where: { id: occurrenceId, makeupStatus: { not: "WAIVED" } }, data: { makeupStatus: "WAIVED", makeupNote: text, makeupUpdatedAt: now, makeupUpdatedById: adminId } });
    if (count === 0) throw new ShiftError("כבר בוצע ויתור על השעה החלופית", "CONFLICT");
    await writeAudit(tx, { action: "shift_makeup.waived", adminId, userId: occ.shift.userId, entityType: "ShiftOccurrence", entityId: occurrenceId, outcome: "ok", reason: text, before: { remainingMinutes: remaining }, after: { remainingMinutes: 0 } });
    return remaining;
  });
  return { occurrenceId, makeupStatus: "WAIVED" as const, waivedMinutes };
}

/**
 * שיבוץ שעה חלופית ע"י מנהל עבור הלקוח: יוצר הזמנה מאושרת וגורע ממנה את משך ההזמנה מהזיכוי של המפגש שבוטל (לא יותר
 * מהיתרה, ולא אחרי הפקיעה). הגריעה אטומית ונעולה (אותה נעילת יתרות כמו כל ניכוי), ולכן אי אפשר לנצל את אותן דקות פעמיים;
 * נכשלה הגריעה — ההזמנה מבוטלת. ההזמנה מסומנת כמשולמת מיתרה, כך שביטולה עוברת במסלול ההחזרה ליתרה הקיים.
 * אין שינוי בחיובי המשמרת. רק חדר פנוי ביום שאינו שבת (אותם כללי התנגשות של הזמנת מנהל).
 */
export async function scheduleMakeupSession(params: {
  occurrenceId: string;
  adminId: string;
  roomKey: RoomKey;
  startTime: Date;
  endTime: Date;
  now?: Date;
  db?: PrismaClient;
}) {
  const { occurrenceId, adminId, roomKey, startTime, endTime, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const occ = await db.shiftOccurrence.findUnique({ where: { id: occurrenceId }, include: { shift: { select: { userId: true } } } });
  if (!occ || occ.makeupStatus === null || !occ.makeupCreditId) throw new ShiftError("אין יתרת שעה חלופית במופע זה", "NOT_FOUND");
  if (occ.makeupStatus === "WAIVED") throw new ShiftError("בוצע ויתור על השעה החלופית", "CONFLICT");
  const minutes = Math.round((endTime.getTime() - startTime.getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes % 15 !== 0) throw new ShiftError("משך השיבוץ חייב להיות מכפלה של רבע שעה", "INVALID");
  const userId = occ.shift.userId;
  const creditId = occ.makeupCreditId;

  const appointment = await createAppointment({ userId, roomKey, startTime, endTime, notes: "שעה חלופית (סגירה ביוזמת ההנהלה)", source: "ADMIN" }).catch((err) => {
    throw err instanceof BookingError ? new ShiftError(err.message, "CONFLICT") : err;
  });
  try {
    const remaining = await db.$transaction(async (tx) => {
      await lockUserBalances(tx, userId);
      const credit = await tx.credit.findUnique({ where: { id: creditId } });
      if (!credit || credit.expiresAt.getTime() <= now.getTime()) throw new ShiftError("הזיכוי פג תוקף", "CONFLICT");
      const { count } = await tx.credit.updateMany({ where: { id: creditId, minutesRemaining: { gte: minutes } }, data: { minutesRemaining: { decrement: minutes } } });
      if (count !== 1) throw new ShiftError("אין מספיק יתרה בשעה החלופית", "CONFLICT");
      await tx.creditUsage.create({ data: { creditId, kind: "CONSUME", minutes, appointmentId: appointment.id } });
      await tx.appointment.update({ where: { id: appointment.id }, data: { paymentStatus: "PAID", paidFromBalanceMinutes: minutes, paidCashAgorot: 0 } });
      const left = credit.minutesRemaining - minutes;
      await tx.shiftOccurrence.update({
        where: { id: occurrenceId },
        data: { makeupUpdatedAt: now, makeupUpdatedById: adminId, ...(left === 0 ? { makeupStatus: "ARRANGED" as const, makeupNote: "הושלם שיבוץ השעה החלופית" } : {}) },
      });
      await writeAudit(tx, { action: "shift_makeup.scheduled", adminId, userId, entityType: "ShiftOccurrence", entityId: occurrenceId, outcome: "ok", after: { minutes, appointmentId: appointment.id, remainingMinutes: left } });
      return left;
    });
    return { occurrenceId, appointmentId: appointment.id, minutes, remainingMinutes: remaining };
  } catch (err) {
    await db.appointment.update({ where: { id: appointment.id }, data: { status: "CANCELLED" } });
    throw err;
  }
}

// ───────────────────────────── תשלום ידני ─────────────────────────────

/**
 * תיעוד תשלום ידני שהתקבל בפועל (מזומן, העברה וכו') ע"י מנהל. החיוב מסומן כשולם רק באישור מפורש (confirm) ובסכום המדויק
 * שהוסכם לחיוב: אין "שולם" אוטומטי ואין תשלום חלקי. חל על חיוב ממתין או שנכשל (גם של משמרת אוטומטית, כשהלקוח שילם בדרך
 * אחרת). חיוב במצב "לא ידוע" מוכרע דרך resolveUnknownCharge. נרשם ביומן הביקורת. לא נוצר Payment מול ספק.
 */
export async function recordManualPayment(params: {
  chargeId: string;
  adminId: string;
  amountAgorot: number;
  /** התאריך שבו התשלום התקבל בפועל (YYYY-MM-DD, לא עתידי) */
  paidOn: string;
  reference?: string;
  confirm: boolean;
  now?: Date;
  db?: PrismaClient;
}) {
  const { chargeId, adminId, amountAgorot, paidOn, reference, confirm, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  if (confirm !== true) throw new ShiftError("יש לאשר במפורש שהתשלום התקבל", "INVALID");
  if (!parseIso(paidOn)) throw new ShiftError("תאריך קבלת התשלום אינו תקין", "INVALID");
  if (paidOn > jerusalemTodayIso(now)) throw new ShiftError("תאריך קבלת התשלום לא יכול להיות עתידי", "INVALID");
  const charge = await db.shiftCharge.findUnique({ where: { id: chargeId }, include: { shift: true } });
  if (!charge) throw new ShiftError("החיוב לא נמצא", "NOT_FOUND");
  if (charge.status === "PAID") throw new ShiftError("החיוב כבר שולם", "CONFLICT");
  if (charge.status === "UNKNOWN") throw new ShiftError("מצב החיוב לא ידוע. יש להכריע אותו בבירור החיוב", "CONFLICT");
  if (charge.status !== "PENDING" && charge.status !== "FAILED") throw new ShiftError("לא ניתן לתעד תשלום בחיוב זה", "CONFLICT");
  if (charge.status === "PENDING" && charge.claimedAt && now.getTime() - charge.claimedAt.getTime() < CHARGE_CLAIM_TTL_MS) {
    throw new ShiftError("החיוב מתבצע כעת מול הספק. יש לנסות שוב בעוד כמה דקות", "CONFLICT");
  }
  if (!Number.isInteger(amountAgorot) || amountAgorot !== charge.amountAgorot) {
    throw new ShiftError("הסכום שהתקבל חייב להיות זהה לסכום החיוב. תשלום חלקי אינו נתמך כאן", "INVALID");
  }
  const ref = clip(reference, 200);

  await db.$transaction(async (tx) => {
    const { count } = await tx.shiftCharge.updateMany({
      where: { id: chargeId, status: { in: ["PENDING", "FAILED"] } },
      data: {
        status: "PAID",
        paidAt: jerusalemWallInstant(paidOn, 12 * 60),
        manualAmountAgorot: amountAgorot,
        manualPaidOn: paidOn,
        manualReference: ref,
        resolvedById: adminId,
        claimedAt: null,
        failureCode: null,
        graceUntil: null,
      },
    });
    if (count === 0) throw new ShiftError("החיוב כבר טופל", "CONFLICT");
    if (charge.isFirst && charge.shift.status === "PENDING") await tx.shift.updateMany({ where: { id: charge.shiftId, status: "PENDING" }, data: { status: "ACTIVE" } });
    await writeAudit(tx, {
      action: "shift_charge.manual_payment",
      adminId,
      userId: charge.shift.userId,
      entityType: "ShiftCharge",
      entityId: chargeId,
      outcome: "ok",
      reason: ref,
      before: { status: charge.status, amountAgorot: charge.amountAgorot },
      after: { status: "PAID", manualAmountAgorot: amountAgorot, manualPaidOn: paidOn },
    });
  });
  if (charge.isFirst && charge.shift.status === "PENDING") await grantMakeupCredits(db, now, { shiftId: charge.shiftId });
  return { chargeId, status: "PAID" as const };
}

// ───────────────────────────── בקשות שינוי וביטול ─────────────────────────────

export async function createShiftRequest(params: {
  userId: string;
  shiftId: string;
  kind: "CHANGE" | "CANCEL";
  reason?: string;
  proposed?: { roomKey?: string; weekday?: number; windowId?: string };
  requestedFrom?: string;
  db?: PrismaClient;
}) {
  const { userId, shiftId, kind, reason, proposed, requestedFrom, db = defaultDb } = params;
  // מסתירים קיום משמרת של אחרים
  const shift = await db.shift.findFirst({ where: { id: shiftId, userId } });
  if (!shift) throw new ShiftError("המשמרת לא נמצאה", "NOT_FOUND");
  if (shift.status !== "ACTIVE" && shift.status !== "SUSPENDED") throw new ShiftError("ניתן להגיש בקשה רק למשמרת פעילה או מושעית", "CONFLICT");
  if (requestedFrom !== undefined && !parseIso(requestedFrom)) throw new ShiftError("תאריך תחילה לא תקין", "INVALID");

  let proposedData: { proposedRoomKey?: string; proposedWeekday?: number; proposedWindowId?: string } = {};
  if (kind === "CHANGE") {
    const { roomKey, weekday, windowId } = proposed ?? {};
    if (roomKey === undefined && weekday === undefined && windowId === undefined) throw new ShiftError("יש לציין מה לשנות", "INVALID");
    if (roomKey !== undefined && !ROOM_KEYS.includes(roomKey as never)) throw new ShiftError("חדר לא קיים", "INVALID");
    if (weekday !== undefined && !SHIFT_WEEKDAYS.includes(weekday as never)) throw new ShiftError("יום בשבוע לא תקין", "INVALID");
    if (windowId !== undefined) await requireActiveWindow(windowId, db);
    proposedData = { proposedRoomKey: roomKey, proposedWeekday: weekday, proposedWindowId: windowId };
  }
  try {
    const request = await db.shiftChangeRequest.create({
      data: { shiftId, userId, kind, reason: clip(reason, MAX_REASON_LENGTH), requestedFrom, ...proposedData },
    });
    return { id: request.id, status: request.status, createdAt: request.createdAt };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ShiftError("כבר קיימת בקשה פתוחה למשמרת זו", "CONFLICT");
    throw err;
  }
}

/**
 * תאריך ברירת המחדל להחלה: מועד החיוב של החיוב הראשון שטרם שולם (אך לא לפני מחר). כך שינוי/ביטול לא נוגעים בתקופה
 * שכבר חויבה אלא אם המנהל בחר במפורש תאריך מוקדם יותר.
 */
export function defaultAppliedFrom(shift: Pick<Shift, "startDate">, charges: Pick<ShiftCharge, "month" | "status">[], todayIso: string): string {
  const tomorrow = addDays(todayIso, 1);
  const dueDates = billingDueDates(shift.startDate);
  const index = billingMonths(shift.startDate).findIndex((m) => !charges.some((c) => c.month === m && c.status === "PAID"));
  const fromDate = index >= 0 ? dueDates[index] : tomorrow;
  return fromDate > tomorrow ? fromDate : tomorrow;
}

export interface DecisionResult {
  requestId: string;
  status: "APPROVED" | "REJECTED";
  appliedFrom?: string;
  cancelledOccurrences?: number;
  createdOccurrences?: number;
  adjust?: AdjustSummary;
}

/**
 * החלטת מנהל בבקשה. עד האישור המשמרת אינה משתנה. דחייה רק מתעדת. אישור ביטול מבטל את המופעים העתידיים מתאריך ההחלה;
 * אישור שינוי מחליף אותם באטומיות במופעים החדשים (בדיקת זמינות מלאה תחת נעילת החדר החדש; כישלון מבטל הכול).
 * חיובים שכבר נגבו: החזר רק אם המנהל ביקש במפורש (refundCharged). שום היסטוריה אינה נמחקת.
 */
export async function decideShiftRequest(params: {
  requestId: string;
  adminId: string;
  decision: "APPROVE" | "REJECT";
  note?: string;
  effectiveFrom?: string;
  refundCharged?: boolean;
  provider: PaymentProvider;
  now?: Date;
  db?: PrismaClient;
}): Promise<DecisionResult> {
  const { requestId, adminId, decision, note, effectiveFrom, refundCharged = false, provider, now = new Date(), db = defaultDb } = params;
  await assertAdmin(db, adminId);
  const request = await db.shiftChangeRequest.findUnique({ where: { id: requestId }, include: { shift: { include: { charges: true, room: true } } } });
  if (!request) throw new ShiftError("הבקשה לא נמצאה", "NOT_FOUND");
  if (request.status !== "PENDING") throw new ShiftError("הבקשה כבר טופלה", "CONFLICT");
  const decisionNote = clip(note, MAX_NOTE_LENGTH);

  if (decision === "REJECT") {
    const { count } = await db.shiftChangeRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "REJECTED", decidedAt: now, decidedById: adminId, decisionNote } });
    if (count === 0) throw new ShiftError("הבקשה כבר טופלה", "CONFLICT");
    return { requestId, status: "REJECTED" };
  }

  const shift = request.shift;
  if (shift.status !== "ACTIVE" && shift.status !== "SUSPENDED") throw new ShiftError("המשמרת אינה פעילה", "CONFLICT");
  const today = jerusalemTodayIso(now);
  if (effectiveFrom !== undefined && !parseIso(effectiveFrom)) throw new ShiftError("תאריך החלה לא תקין", "INVALID");
  const appliedFrom = effectiveFrom ?? request.requestedFrom ?? defaultAppliedFrom(shift, shift.charges, today);
  const from = appliedFrom > addDays(today, 0) ? appliedFrom : addDays(today, 1);

  const future = await db.shiftOccurrence.findMany({ where: { shiftId: shift.id, status: "SCHEDULED", date: { gte: from } } });

  if (request.kind === "CANCEL") {
    const cancelled = await db.$transaction(async (tx) => {
      const claimed = await tx.shiftChangeRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "APPROVED", decidedAt: now, decidedById: adminId, decisionNote, appliedFrom: from } });
      if (claimed.count === 0) throw new ShiftError("הבקשה כבר טופלה", "CONFLICT");
      const appointmentIds = future.map((o) => o.appointmentId).filter((x): x is string => !!x);
      await tx.appointment.updateMany({ where: { id: { in: appointmentIds }, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
      await tx.shiftOccurrence.updateMany({ where: { id: { in: future.map((o) => o.id) } }, data: { status: "CANCELLED", statusNote: "cancel_request_approved" } });
      await tx.shift.update({ where: { id: shift.id }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: "cancel_request_approved" } });
      return future.length;
    });
    const removed = await db.shiftOccurrence.findMany({ where: { id: { in: future.map((o) => o.id) } } });
    const adjust = await adjustChargesForRemovedOccurrences(db, provider, removed, { refundPaid: refundCharged, reason: "shift_cancel_approved", actorId: adminId });
    return { requestId, status: "APPROVED", appliedFrom: from, cancelledOccurrences: cancelled, adjust };
  }

  // CHANGE
  // לא משנים חודש שכבר חויב: מחיר/כמות המופעים בו כבר נגבו. שינוי בחודש כזה מחייב ביטול מפורש עם החזר, לא שינוי שקט
  if (shift.charges.some((c) => c.status === "PAID" && c.month >= periodKeyOf(shift.startDate, from))) {
    throw new ShiftError("התקופה הנבחרת כבר חויבה. יש לבחור תאריך החלה מהתקופה הבאה שטרם חויבה, או לטפל בכך כביטול עם החזר", "CONFLICT");
  }
  const newRoomKey = (request.proposedRoomKey ?? shift.room.key) as never;
  const newWeekday = request.proposedWeekday ?? shift.weekday;
  const newWindow = request.proposedWindowId ?? shift.windowId;
  // משבצת שהושבתה מאז ההזמנה נשארת תקפה למשמרת הקיימת (שינוי חדר/יום), אך לא ניתן לעבור אליה
  const windowDef = await requireActiveWindow(newWindow, db, { allowInactive: newWindow === shift.windowId });
  if (newRoomKey === shift.room.key && newWeekday === shift.weekday && newWindow === shift.windowId) {
    throw new ShiftError("הבקשה אינה משנה דבר", "INVALID");
  }

  const planned = await planOccurrences({ userId: shift.userId, roomKey: newRoomKey, weekday: newWeekday, windowId: newWindow, from, to: shift.endDate, startDate: shift.startDate, allowInactiveWindow: newWindow === shift.windowId }, db).catch((err) => {
    if (err instanceof ShiftError && err.message === "אין מופעים בתקופה שנבחרה") return { occurrences: [], conflicts: [], window: windowDef };
    throw err;
  });
  if (planned.conflicts.length > 0) throw new ShiftError("לא ניתן להחיל את השינוי בגלל התנגשויות", "CONFLICT", { conflicts: planned.conflicts });

  const newRoom = await db.room.findUniqueOrThrow({ where: { key: newRoomKey } });
  const created = await db.$transaction(async (tx) => {
    await lockRoomZone(tx, newRoomKey);
    const claimed = await tx.shiftChangeRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "APPROVED", decidedAt: now, decidedById: adminId, decisionNote, appliedFrom: from } });
    if (claimed.count === 0) throw new ShiftError("הבקשה כבר טופלה", "CONFLICT");

    // קודם משחררים את המופעים העתידיים הישנים, ורק אז בודקים התנגשויות: המשמרת אינה מתנגשת בעצמה
    await tx.appointment.updateMany({ where: { id: { in: future.map((o) => o.appointmentId).filter((x): x is string => !!x) }, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
    await tx.shiftOccurrence.updateMany({ where: { id: { in: future.map((o) => o.id) } }, data: { status: "CANCELLED", statusNote: "replaced_by_change_request" } });

    const conflicts = await findRoomConflicts(tx, newRoomKey, planned.occurrences, now);
    if (conflicts.length > 0) throw new ShiftError("החדר תפוס באחד או יותר מהמופעים החדשים", "CONFLICT", { conflicts });

    for (const occ of planned.occurrences) {
      // תאריך שכבר יש עליו שורת מופע (נוצר/בוטל קודם) נשאר בהיסטוריה; מופע חדש באותו תאריך מקבל מפתח ייחודי חדש בהחלפה
      const existing = await tx.shiftOccurrence.findUnique({ where: { shiftId_date: { shiftId: shift.id, date: occ.date } } });
      if (existing && existing.status === "SCHEDULED") continue;
      if (occ.skipReason) {
        if (existing) await tx.shiftOccurrence.update({ where: { id: existing.id }, data: { status: "SKIPPED_CLOSED_DAY", statusNote: occ.skipReason, makeupStatus: "OWED" } });
        else await tx.shiftOccurrence.create({ data: { shiftId: shift.id, date: occ.date, month: occ.month, startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, status: "SKIPPED_CLOSED_DAY", statusNote: occ.skipReason, makeupStatus: "OWED" } });
        continue;
      }
      const appointment = await tx.appointment.create({
        data: { userId: shift.userId, roomId: newRoom.id, startTime: occ.startTime, endTime: occ.endTime, status: "CONFIRMED", source: "SHIFT", notes: "משמרת קבועה" },
      });
      const data = { startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, appointmentId: appointment.id, status: "SCHEDULED" as const, statusNote: "changed_by_request", refundedAgorot: 0 };
      if (existing) await tx.shiftOccurrence.update({ where: { id: existing.id }, data });
      else await tx.shiftOccurrence.create({ data: { shiftId: shift.id, date: occ.date, month: occ.month, ...data } });
    }
    await tx.shift.update({
      where: { id: shift.id },
      data: { roomId: newRoom.id, weekday: newWeekday, windowId: newWindow, occurrencePriceAgorot: Math.round(windowDef.monthlyPriceAgorot / 4), monthlyPriceAgorot: windowDef.monthlyPriceAgorot },
    });
    return planned.occurrences.filter((o) => !o.skipReason).length;
  });

  // חיובים עתידיים שטרם נגבו מתעדכנים לבד: הסכום מחושב מהמופעים המתוזמנים בעת החיוב. חיוב שנכשל מרוענן בניסיון החוזר
  await grantMakeupCredits(db, now, { shiftId: shift.id });
  return { requestId, status: "APPROVED", appliedFrom: from, cancelledOccurrences: future.length, createdOccurrences: created };
}
