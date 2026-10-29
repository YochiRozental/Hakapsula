import type { PrismaClient, Shift, ShiftCharge, ShiftOccurrence } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { lockRoomZone } from "@/lib/booking";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";
import type { PaymentProvider } from "@/lib/payments/provider";
import { ROOM_KEYS } from "@/lib/rooms";
import {
  addDays,
  billingMonths,
  isShiftWindowId,
  monthKeyOf,
  monthStartIso,
  occurrencePriceAgorot,
  parseIso,
  SHIFT_WEEKDAYS,
  type ShiftWindowId,
} from "@/lib/shifts/calendar";
import { chargeShiftMonth, graceDeadline, refundChargeAmount, type ChargeResult } from "@/lib/shifts/billing";
import { ShiftError } from "@/lib/shifts/errors";
import { MAX_NOTE_LENGTH, MAX_REASON_LENGTH } from "@/lib/shifts/policy";
import { abortPendingShift, findRoomConflicts, planOccurrences } from "@/lib/shifts/schedule";
import { isUniqueViolation } from "@/lib/payments/shared";

/**
 * מחזור החיים של משמרת אחרי היצירה: זכאות, השעיה וחידוש, בירור חיוב לא ידוע, סגירת יום מפורשת, ובקשות שינוי/ביטול.
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
    if (charge.isFirst && charge.shift.status === "PENDING") await db.shift.updateMany({ where: { id: charge.shiftId, status: "PENDING" }, data: { status: "ACTIVE" } });
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

// ───────────────────────────── סגירת יום מפורשת ─────────────────────────────

export interface DayClosureSummary extends AdjustSummary {
  date: string;
  skipped: number;
}

/**
 * סגירה מפורשת של תאריך ע"י מנהל משפיעה על מופעי משמרות באותו יום: המופע מדולג (ללא חיוב), הזמנתו מבוטלת והחדר מתפנה,
 * ואם החודש כבר שולם מוחזר סכום המופע. שינוי רגיל בשעות הפעילות אינו קורא לפונקציה הזו ואינו מבטל דבר. אידמפוטנטי:
 * הרצה חוזרת משלימה החזרים שנכשלו או שחיכו לבירור. ההיסטוריה נשמרת (שום שורה אינה נמחקת).
 */
export async function applyDayClosure(params: { date: string; adminId: string; provider: PaymentProvider; now?: Date; db?: PrismaClient }): Promise<DayClosureSummary> {
  const { date, adminId, provider, db = defaultDb } = params;
  await assertAdmin(db, adminId);
  if (!parseIso(date)) throw new ShiftError("תאריך לא תקין", "INVALID");

  const live = await db.shiftOccurrence.findMany({
    where: { date, status: { in: ["SCHEDULED", "SKIPPED_CLOSED_DAY"] }, shift: { status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } } },
  });
  let skipped = 0;
  for (const occ of live.filter((o) => o.status === "SCHEDULED")) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.shiftOccurrence.updateMany({ where: { id: occ.id, status: "SCHEDULED" }, data: { status: "SKIPPED_CLOSED_DAY", statusNote: `closed_day:${date}` } });
      if (count === 1 && occ.appointmentId) await tx.appointment.updateMany({ where: { id: occ.appointmentId, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
      skipped += count;
    });
  }
  const refreshed = await db.shiftOccurrence.findMany({ where: { id: { in: live.map((o) => o.id) }, status: "SKIPPED_CLOSED_DAY" } });
  const adjust = await adjustChargesForRemovedOccurrences(db, provider, refreshed, { refundPaid: true, reason: "shift_day_closed", actorId: adminId });
  return { date, skipped, ...adjust };
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
    if (windowId !== undefined && !isShiftWindowId(windowId)) throw new ShiftError("משבצת לא קיימת", "INVALID");
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
 * תאריך ברירת המחדל להחלה: היום הראשון של החודש הראשון שטרם שולם (אך לא לפני מחר). כך שינוי/ביטול לא נוגעים בחודש
 * שכבר חויב אלא אם המנהל בחר במפורש תאריך מוקדם יותר.
 */
export function defaultAppliedFrom(shift: Pick<Shift, "startDate">, charges: Pick<ShiftCharge, "month" | "status">[], todayIso: string): string {
  const tomorrow = addDays(todayIso, 1);
  const firstUnpaid = billingMonths(shift.startDate).find((m) => !charges.some((c) => c.month === m && c.status === "PAID"));
  const fromMonth = firstUnpaid ? monthStartIso(firstUnpaid) : tomorrow;
  return fromMonth > tomorrow ? fromMonth : tomorrow;
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
  if (shift.charges.some((c) => c.status === "PAID" && c.month >= monthKeyOf(from))) {
    throw new ShiftError("החודש הנבחר כבר חויב. יש לבחור תאריך החלה מהחודש הבא שטרם חויב, או לטפל בכך כביטול עם החזר", "CONFLICT");
  }
  const newRoomKey = (request.proposedRoomKey ?? shift.room.key) as never;
  const newWeekday = request.proposedWeekday ?? shift.weekday;
  const newWindow = (request.proposedWindowId ?? shift.windowId) as ShiftWindowId;
  if (newRoomKey === shift.room.key && newWeekday === shift.weekday && newWindow === shift.windowId) {
    throw new ShiftError("הבקשה אינה משנה דבר", "INVALID");
  }

  const planned = await planOccurrences({ userId: shift.userId, roomKey: newRoomKey, weekday: newWeekday, windowId: newWindow, from, to: shift.endDate }, db).catch((err) => {
    if (err instanceof ShiftError && err.message === "אין מופעים בתקופה שנבחרה") return { occurrences: [], conflicts: [] };
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
        if (existing) await tx.shiftOccurrence.update({ where: { id: existing.id }, data: { status: "SKIPPED_CLOSED_DAY", statusNote: occ.skipReason } });
        else await tx.shiftOccurrence.create({ data: { shiftId: shift.id, date: occ.date, month: occ.month, startTime: occ.startTime, endTime: occ.endTime, priceAgorot: occ.priceAgorot, status: "SKIPPED_CLOSED_DAY", statusNote: occ.skipReason } });
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
      data: { roomId: newRoom.id, weekday: newWeekday, windowId: newWindow, occurrencePriceAgorot: occurrencePriceAgorot(newWindow) },
    });
    return planned.occurrences.filter((o) => !o.skipReason).length;
  });

  // חיובים עתידיים שטרם נגבו מתעדכנים לבד: הסכום מחושב מהמופעים המתוזמנים בעת החיוב. חיוב שנכשל מרוענן בניסיון החוזר
  return { requestId, status: "APPROVED", appliedFrom: from, cancelledOccurrences: future.length, createdOccurrences: created };
}
