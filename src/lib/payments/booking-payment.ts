import { prisma } from "@/lib/prisma";
import { BookingError, blockingAppointmentWhere, createBookingHold, lockRoomZone } from "@/lib/booking";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";
import { regularPriceAgorot, splitBookingPrice } from "@/lib/payments/pricing";
import { isAutoRefundEligible } from "@/lib/payments/policy";
import type { PaymentProvider } from "@/lib/payments/provider";
import type { BookingSource, Payment, RoomKey } from "@/generated/prisma/client";
import {
  PaymentFlowError,
  audit,
  environmentOf,
  isUniqueViolation,
  lockAppointmentRow,
  lockPaymentRow,
  lockUserBalances,
  type Tx,
} from "@/lib/payments/shared";
import { consumeBalance, loadUsableBalances, restoreAppointmentBalance, toPackageBalance } from "@/lib/payments/balances";
import { finalizePackagePayment, type PackageFinalizeResult } from "@/lib/payments/packages";
import { findUsableCard } from "@/lib/payments/saved-methods";
import { waiveOpenDebtForAppointment } from "@/lib/payments/debts";

export { PaymentFlowError } from "@/lib/payments/shared";
export type { FlowErrorCode } from "@/lib/payments/shared";

/**
 * תשלום על הזמנה (שלבים C+D). מקור האמת לתשלומים, להזמנות וליתרות הוא PostgreSQL בלבד.
 *
 * סדר נעילות עקבי בכל טרנזקציה (מונע deadlock): 1) advisory lock של אזור החדר, 2) שורת ההזמנה (FOR UPDATE),
 * 3) שורת התשלום, 4) יתרות הלקוח (חבילות ואז זיכויים). קריאות לספק החיצוני מתבצעות מחוץ לטרנזקציות.
 *
 * הזמנה מאושרת אך ורק בתוך טרנזקציה אחת שכוללת: אימות שההחזקה בתוקף, בדיקת התנגשות, ניכוי הדקות מהיתרה,
 * ועדכון ההזמנה. ניכוי דקות מעולם לא מתבצע בעת יצירת ההחזקה או לפני שהתשלום בכסף (אם יש) אומת בצד השרת.
 */

function durationOf(appt: { startTime: Date; endTime: Date }): number {
  return (appt.endTime.getTime() - appt.startTime.getTime()) / 60_000;
}

function priceFor(appt: { startTime: Date; endTime: Date }): number {
  try {
    // המחיר מחושב בשרת מתוך זמני ההזמנה השמורים. סכום מהלקוח אינו נקלט בשום מקום
    return regularPriceAgorot(durationOf(appt));
  } catch {
    throw new PaymentFlowError("משך ההזמנה אינו ניתן לתמחור (חייב להיות מכפלה של 15 דקות)", "INVALID");
  }
}

function assertActiveHold(appt: { status: string; holdExpiresAt: Date | null }, now: Date) {
  if (appt.status !== "PENDING_PAYMENT") {
    throw new PaymentFlowError("ההזמנה אינה ממתינה לתשלום", "CONFLICT");
  }
  if (!appt.holdExpiresAt || appt.holdExpiresAt.getTime() <= now.getTime()) {
    throw new PaymentFlowError("ההחזקה פגה, יש לבחור שעה מחדש", "EXPIRED");
  }
}

/** רשת ביטחון: החזקה פעילה חוסמת מתחרים, ולכן לא צפויה התנגשות; בודקים בכל זאת לפני אישור */
async function hasBlockingConflict(
  tx: Tx,
  appt: { id: string; startTime: Date; endTime: Date },
  roomKey: RoomKey,
  now: Date
) {
  const count = await tx.appointment.count({
    where: {
      ...blockingAppointmentWhere(now),
      id: { not: appt.id },
      room: { key: { in: CONFLICTING_ROOM_KEYS[roomKey] } },
      startTime: { lt: appt.endTime },
      endTime: { gt: appt.startTime },
    },
  });
  return count > 0;
}

// ───────────────────────────── יצירת החזקה ─────────────────────────────

export async function holdRoom(params: {
  userId: string;
  roomKey: RoomKey;
  startTime: Date;
  endTime: Date;
  notes?: string;
  source?: BookingSource;
  now?: Date;
}) {
  return createBookingHold(params);
}

// ───────────────────────────── תכנון תשלום (יתרה + כסף) ─────────────────────────────

export interface BookingPlan {
  durationMinutes: number;
  /** דקות שיינוכו מיתרות (חבילות וזיכויים) באישור */
  packageMinutes: number;
  /** מה שנשאר לתשלום בכסף, באגורות */
  cashAgorot: number;
  fullyCoveredByBalance: boolean;
}

async function planFor(
  appt: { startTime: Date; endTime: Date },
  userId: string,
  now: Date,
  useBalance: boolean
): Promise<BookingPlan> {
  const durationMinutes = durationOf(appt);
  const fullPrice = priceFor(appt); // מוודא שהמשך ניתן לתמחור
  if (!useBalance) return { durationMinutes, packageMinutes: 0, cashAgorot: fullPrice, fullyCoveredByBalance: false };
  const sources = await loadUsableBalances(prisma, userId, now);
  const split = splitBookingPrice(durationMinutes, sources.map(toPackageBalance), now);
  return {
    durationMinutes,
    packageMinutes: split.packageMinutes,
    cashAgorot: split.regularPriceAgorot,
    fullyCoveredByBalance: split.regularMinutes === 0,
  };
}

/** הצעת מחיר להחזקה: כמה יינוכה מהיתרה וכמה ישולם בכסף. קריאה בלבד, אינה שומרת ואינה מנכה כלום */
export async function quoteHold(params: { appointmentId: string; userId: string; useBalance?: boolean; now?: Date }) {
  const { appointmentId, userId, useBalance = true, now = new Date() } = params;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt || appt.userId !== userId) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  assertActiveHold(appt, now);
  return { ...(await planFor(appt, userId, now, useBalance)), holdExpiresAt: appt.holdExpiresAt! };
}

// ───────────────────────────── התחלת תשלום בכסף ─────────────────────────────

export interface StartedPayment {
  paymentId: string;
  providerPaymentId: string;
  checkoutUrl?: string;
  /** החלק בכסף, באגורות */
  amountAgorot: number;
  /** החלק שיינוכה מהיתרה באישור */
  packageMinutes: number;
  holdExpiresAt: Date;
}

/**
 * פותח (או ממשיך) בקשת תשלום להחזקה. אם ללקוח יש יתרה, רק ההפרש נגבה בכסף והדקות מיתרה יינוכו באישור.
 * אידמפוטנטי: לחיצה כפולה/רענון מחזירים את אותו תשלום ממתין. אם היתרה השתנתה מאז שנפתח התשלום הממתין,
 * התשלום הישן מבוטל אצל הספק ונפתח חדש בסכום המעודכן.
 * הבטחה ברמת המסד: אינדקס ייחודי חלקי מאפשר לכל היותר תשלום הזמנה ממתין אחד להזמנה.
 */
export async function startBookingPayment(params: {
  appointmentId: string;
  userId: string;
  provider: PaymentProvider;
  now?: Date;
  useBalance?: boolean;
}): Promise<StartedPayment> {
  const { appointmentId, userId, provider, now = new Date(), useBalance = true } = params;

  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  // מסתירים קיום הזמנה של אחרים
  if (!appt || appt.userId !== userId) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  assertActiveHold(appt, now);

  const plan = await planFor(appt, userId, now, useBalance);
  if (plan.fullyCoveredByBalance) {
    throw new PaymentFlowError("היתרה מכסה את ההזמנה במלואה; יש לאשר מהיתרה ללא תשלום", "INVALID");
  }

  let payment: Payment | undefined;
  for (let attempt = 0; attempt < 3 && !payment; attempt++) {
    const found = await ensurePendingPayment({ appointmentId, userId, plan, provider, now });
    if (!found.stale) {
      payment = found.payment;
    } else {
      await retireStalePayment(found.stale, provider, now);
    }
  }
  if (!payment) throw new PaymentFlowError("לא ניתן לפתוח תשלום כעת, נסו שוב", "CONFLICT");

  // הקריאה לספק אידמפוטנטית לפי אותו מפתח: אם נפלנו לפני שמירת המזהה, ניסיון חוזר ימשיך מאותה נקודה
  const request = await provider.createPaymentRequest({
    amountAgorot: payment.amountAgorot,
    currency: "ILS",
    description: "תשלום על הזמנת חדר",
    idempotencyKey: payment.idempotencyKey,
    customerRef: userId,
    metadata: { appointmentId },
  });
  if (!payment.providerPaymentId) {
    await prisma.payment.updateMany({
      where: { id: payment.id, providerPaymentId: null },
      data: { providerPaymentId: request.providerPaymentId },
    });
    await audit(payment.id, "create", "ok");
  }

  return {
    paymentId: payment.id,
    providerPaymentId: request.providerPaymentId,
    checkoutUrl: request.checkoutUrl,
    amountAgorot: payment.amountAgorot,
    packageMinutes: payment.packageMinutes,
    holdExpiresAt: appt.holdExpiresAt!,
  };
}

async function ensurePendingPayment(params: {
  appointmentId: string;
  userId: string;
  plan: BookingPlan;
  provider: PaymentProvider;
  now: Date;
  /** תשלום באמצעי תשלום שמור. תשלום ממתין עם אמצעי אחר (או בלי) נחשב מיושן */
  paymentMethodId?: string;
}): Promise<{ payment: Payment; stale?: undefined } | { stale: Payment; payment?: undefined }> {
  const { appointmentId, userId, plan, provider, now, paymentMethodId } = params;
  const samePlan = (p: Payment) =>
    p.packageMinutes === plan.packageMinutes && p.amountAgorot === plan.cashAgorot && p.paymentMethodId === (paymentMethodId ?? null);
  const classify = (p: Payment) => (samePlan(p) ? { payment: p } : { stale: p });

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAppointmentRow(tx, appointmentId);
      const fresh = await tx.appointment.findUnique({ where: { id: appointmentId } });
      if (!fresh) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
      assertActiveHold(fresh, now);

      const pending = await tx.payment.findFirst({ where: { appointmentId, purpose: "BOOKING", status: "PENDING" } });
      if (pending) return classify(pending);

      const previousAttempts = await tx.payment.count({ where: { appointmentId, purpose: "BOOKING" } });
      const created = await tx.payment.create({
        data: {
          userId,
          appointmentId,
          purpose: "BOOKING",
          amountAgorot: plan.cashAgorot,
          packageMinutes: plan.packageMinutes,
          paymentMethodId: paymentMethodId ?? null,
          status: "PENDING",
          environment: environmentOf(provider),
          provider: provider.name,
          // מפתח דטרמיניסטי לניסיון: שני ניסיונות מקבילים מתנגשים על אותו מפתח ואחד מהם מקבל את הקיים
          idempotencyKey: `booking:${appointmentId}:${previousAttempts + 1}`,
        },
      });
      return { payment: created };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.payment.findFirst({ where: { appointmentId, purpose: "BOOKING", status: "PENDING" } });
      if (existing) return classify(existing);
    }
    throw err;
  }
}

/** מבטל תשלום ממתין שהתוכנית שלו התיישנה (היתרה השתנתה). אם הספק כבר גבה, מסיים אותו כרגיל ומדווח התנגשות */
async function retireStalePayment(stale: Payment, provider: PaymentProvider, now: Date) {
  try {
    if (stale.providerPaymentId) await provider.cancelPayment(stale.providerPaymentId);
    await prisma.payment.updateMany({ where: { id: stale.id, status: "PENDING" }, data: { status: "CANCELLED" } });
    await audit(stale.id, "cancel", "ok", "stale_plan");
  } catch {
    await audit(stale.id, "cancel", "error", "cancel_rejected");
    try {
      await finalizeBookingPayment({ paymentId: stale.id, provider, now });
    } catch (err) {
      console.error("[payments] finalize after failed retire", err instanceof Error ? err.name : "unknown");
    }
    throw new PaymentFlowError("התשלום הקודם כבר בעיבוד, בדקו את מצב ההזמנה", "CONFLICT");
  }
}

// ───────────────────────────── אישור מיתרה בלבד ─────────────────────────────

export interface BalanceConfirmResult {
  outcome: "CONFIRMED" | "ALREADY_CONFIRMED";
  appointmentId: string;
  minutes: number;
}

/**
 * מאשר הזמנה שמכוסה במלואה מיתרת חבילות/זיכויים, בלי תשלום בכסף. ההחזקה (10 דקות) נדרשת גם כאן.
 * הניכוי והאישור באותה טרנזקציה: אם ההחזקה פגה או שהיתרה אינה מספיקה לא מנוכה דבר ולא מאושרת ההזמנה.
 * שתי הזמנות מקבילות על אותה יתרה מסודרות בטור ע"י נעילת יתרות הלקוח; השנייה נכשלת בלי ניכוי חלקי.
 */
export async function confirmBookingFromBalance(params: {
  appointmentId: string;
  userId: string;
  provider: PaymentProvider;
  now?: Date;
}): Promise<BalanceConfirmResult> {
  const { appointmentId, userId, provider, now = new Date() } = params;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { room: true } });
  if (!appt || appt.userId !== userId) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  const minutes = durationOf(appt);
  priceFor(appt); // מוודא שהמשך ניתן לתמחור

  if (appt.status === "CONFIRMED" && appt.paidFromBalanceMinutes === minutes && appt.paidCashAgorot === 0) {
    return { outcome: "ALREADY_CONFIRMED", appointmentId, minutes };
  }
  assertActiveHold(appt, now);

  // אם נפתח תשלום בכסף והלקוח עבר לשלם מיתרה: מבטלים אותו קודם (או מסיימים אותו אם כבר הצליח)
  await cancelPendingPayments(appt.id, provider, now);

  return prisma.$transaction(async (tx) => {
    await lockRoomZone(tx, appt.room.key);
    await lockAppointmentRow(tx, appt.id);
    const fresh = await tx.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    // בקשה מקבילה כבר אישרה מיתרה: אידמפוטנטי, בלי ניכוי נוסף (הבדיקה אחרי הנעילה, כי שם המצב סופי)
    if (fresh.status === "CONFIRMED" && fresh.paidFromBalanceMinutes === minutes && fresh.paidCashAgorot === 0) {
      return { outcome: "ALREADY_CONFIRMED" as const, appointmentId, minutes };
    }
    assertActiveHold(fresh, now);

    const inFlight = await tx.payment.count({
      where: { appointmentId: appt.id, purpose: "BOOKING", status: { in: ["PENDING", "SUCCEEDED"] } },
    });
    if (inFlight > 0) throw new PaymentFlowError("יש תשלום בתהליך להזמנה זו", "CONFLICT");
    if (await hasBlockingConflict(tx, appt, appt.room.key, now)) {
      throw new PaymentFlowError("החדר כבר אינו פנוי", "CONFLICT");
    }

    await lockUserBalances(tx, userId);
    const consumed = await consumeBalance(tx, { userId, appointmentId: appt.id, minutes, now });
    if (!consumed.ok) throw new PaymentFlowError("אין מספיק יתרה בחבילות להזמנה זו", "INSUFFICIENT_BALANCE");

    await tx.appointment.update({
      where: { id: appt.id },
      data: {
        status: "CONFIRMED",
        holdExpiresAt: null,
        paymentStatus: "PAID",
        paidFromBalanceMinutes: minutes,
        paidCashAgorot: 0,
      },
    });
    return { outcome: "CONFIRMED" as const, appointmentId, minutes };
  });
}

// ───────────────────────────── אימות ואישור ─────────────────────────────

export type FinalizeOutcome =
  | "CONFIRMED"
  | "ALREADY_CONFIRMED"
  | "PENDING"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "AMOUNT_MISMATCH"
  | "LATE_REFUNDED"
  | "LATE_REFUND_FAILED"
  | "BALANCE_CHANGED_REFUNDED"
  | "BALANCE_CHANGED_REFUND_FAILED";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  paymentId: string;
  appointmentId: string;
}

type SettleKind = "late" | "balance";

/**
 * שולף את סטטוס התשלום מהספק (בצד השרת), מאמת סכום ובעלות, ומאשר את ההזמנה אם ורק אם התשלום הצליח וההחזקה בתוקף.
 * בתשלום משולב, באותה טרנזקציה מנוכות גם הדקות המתוכננות מהיתרה. אידמפוטנטי ובטוח להפעלה חוזרת/מקבילית.
 * תשלום שהצליח אחרי פקיעת ההחזקה, או שהיתרה כבר אינה מספיקה לחלק המתוכנן, אינו מאשר הזמנה ואינו מנכה דקות:
 * הוא מוחזר ללקוח במלואו וההזמנה מבוטלת.
 *
 * beforeApply: נקודת הזרקה לבדיקות בלבד, כדי לדמות כישלון זמני בין אישור הספק לעדכון ההזמנה.
 */
export async function finalizeBookingPayment(params: {
  paymentId: string;
  provider: PaymentProvider;
  now?: Date;
  beforeApply?: () => Promise<void>;
}): Promise<FinalizeResult> {
  const { paymentId, provider, now = new Date(), beforeApply } = params;

  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { appointment: { include: { room: true } } } });
  if (!payment || payment.purpose !== "BOOKING" || !payment.appointment) {
    throw new PaymentFlowError("התשלום לא נמצא", "NOT_FOUND");
  }
  if (payment.provider !== provider.name || payment.environment !== environmentOf(provider)) {
    // תשלום SANDBOX לעולם לא ייפתר מול ספק LIVE ולהפך
    throw new PaymentFlowError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }
  const result = (outcome: FinalizeOutcome): FinalizeResult => ({
    outcome,
    paymentId: payment.id,
    appointmentId: payment.appointmentId!,
  });

  if (!payment.providerPaymentId) return result("PENDING");
  if (payment.status === "FAILED") return result("PAYMENT_FAILED");
  if (payment.status === "CANCELLED") return result("PAYMENT_CANCELLED");
  if (payment.status === "SUCCEEDED") {
    return settledResult(payment.id, payment.appointment.status, provider, result, "late");
  }

  const verified = await provider.getPaymentStatus(payment.providerPaymentId);
  if (verified.providerPaymentId !== payment.providerPaymentId) {
    throw new PaymentFlowError("תשובת הספק אינה תואמת לתשלום", "INVALID");
  }
  if (verified.amountAgorot !== payment.amountAgorot) {
    // הסכום שהספק גבה שונה ממה ששמרנו אצלנו: לא מאשרים אוטומטית. נדרש טיפול ידני
    await audit(payment.id, "status", "error", "amount_mismatch");
    return result("AMOUNT_MISMATCH");
  }

  if (verified.status === "PENDING") return result("PENDING");
  if (verified.status === "FAILED" || verified.status === "CANCELLED") {
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: verified.status, failureCode: verified.failureCode ?? null },
    });
    await audit(payment.id, "status", "ok", verified.status.toLowerCase());
    return result(verified.status === "FAILED" ? "PAYMENT_FAILED" : "PAYMENT_CANCELLED");
  }

  await beforeApply?.();

  const applied = await prisma.$transaction(async (tx): Promise<"CONFIRMED" | "LATE" | "BALANCE"> => {
    await lockRoomZone(tx, payment.appointment!.room.key);
    await lockAppointmentRow(tx, payment.appointmentId!);
    await lockPaymentRow(tx, payment.id);

    const pay = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: payment.appointmentId! } });
    if (pay.status !== "SUCCEEDED") {
      await tx.payment.update({ where: { id: pay.id }, data: { status: "SUCCEEDED", paidAt: now, failureCode: null } });
    }
    if (appt.status === "CONFIRMED" && appt.paymentStatus === "PAID") return "CONFIRMED";

    const holdActive = appt.status === "PENDING_PAYMENT" && !!appt.holdExpiresAt && appt.holdExpiresAt.getTime() > now.getTime();
    if (holdActive && !(await hasBlockingConflict(tx, appt, payment.appointment!.room.key, now))) {
      if (pay.packageMinutes > 0) {
        await lockUserBalances(tx, appt.userId);
        const consumed = await consumeBalance(tx, {
          userId: appt.userId,
          appointmentId: appt.id,
          minutes: pay.packageMinutes,
          now,
        });
        if (!consumed.ok) {
          // היתרה השתנתה בזמן התשלום (נוצלה/פגה). לא מנכים כלום ולא מאשרים; הכסף יוחזר
          await tx.appointment.update({ where: { id: appt.id }, data: { status: "CANCELLED", holdExpiresAt: null } });
          return "BALANCE";
        }
      }
      await tx.appointment.update({
        where: { id: appt.id },
        data: {
          status: "CONFIRMED",
          holdExpiresAt: null,
          paymentStatus: "PAID",
          paidFromBalanceMinutes: pay.packageMinutes,
          paidCashAgorot: pay.amountAgorot,
        },
      });
      return "CONFIRMED";
    }
    if (appt.status === "PENDING_PAYMENT") {
      await tx.appointment.update({ where: { id: appt.id }, data: { status: "CANCELLED", holdExpiresAt: null } });
    }
    return "LATE";
  });

  if (applied === "CONFIRMED") {
    await audit(payment.id, "status", "ok", "confirmed");
    return result("CONFIRMED");
  }
  await audit(payment.id, "status", "ok", applied === "BALANCE" ? "balance_changed" : "late_payment");
  return settledResult(payment.id, "CANCELLED", provider, result, applied === "BALANCE" ? "balance" : "late");
}

/** תשלום שהצליח: אם ההזמנה מאושרת הכול תקין; אחרת (איחור/ביטול/שינוי יתרה) מבטיחים שהכסף הוחזר */
async function settledResult(
  paymentId: string,
  appointmentStatus: string,
  provider: PaymentProvider,
  result: (o: FinalizeOutcome) => FinalizeResult,
  kind: SettleKind
): Promise<FinalizeResult> {
  if (appointmentStatus === "CONFIRMED") return result("ALREADY_CONFIRMED");
  try {
    await refundPaymentFull({
      paymentId,
      provider,
      reason: kind === "balance" ? "balance_changed_during_payment" : "late_payment_no_confirmation",
    });
    return result(kind === "balance" ? "BALANCE_CHANGED_REFUNDED" : "LATE_REFUNDED");
  } catch (err) {
    console.error("[payments] settle refund failed", err instanceof Error ? err.message : "unknown");
    return result(kind === "balance" ? "BALANCE_CHANGED_REFUND_FAILED" : "LATE_REFUND_FAILED");
  }
}

// ───────────────────────────── החזרים ─────────────────────────────

/**
 * החזר מלא של היתרה שטרם הוחזרה, דרך שכבת הספק. מפתח אחד לכל תשלום (refund-full:<id>) לכל מסלולי ההחזר
 * (איחור, שינוי יתרה, ביטול, אישור מנהל), ולכן אי אפשר להחזיר פעמיים. כשל בספק משאיר שורת Refund ממתינה לניסיון חוזר.
 */
export async function refundPaymentFull(params: {
  paymentId: string;
  provider: PaymentProvider;
  reason: string;
  createdById?: string;
}) {
  const { paymentId, provider, reason, createdById } = params;
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
  if (!payment || !payment.providerPaymentId) throw new PaymentFlowError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.status !== "SUCCEEDED") throw new PaymentFlowError("ניתן להחזיר רק תשלום שהצליח", "INVALID");
  if (payment.provider !== provider.name || payment.environment !== environmentOf(provider)) {
    throw new PaymentFlowError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }

  const key = `refund-full:${payment.id}`;
  let refund = payment.refunds.find((r) => r.idempotencyKey === key);
  if (refund?.status === "SUCCEEDED") return refund;

  if (!refund) {
    const refundedSoFar = payment.refunds.filter((r) => r.status !== "FAILED").reduce((sum, r) => sum + r.amountAgorot, 0);
    const remaining = payment.amountAgorot - refundedSoFar;
    if (remaining <= 0) return null;
    try {
      refund = await prisma.refund.create({
        data: { paymentId: payment.id, amountAgorot: remaining, status: "PENDING", reason, idempotencyKey: key, createdById },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      refund = await prisma.refund.findUniqueOrThrow({ where: { idempotencyKey: key } });
      if (refund.status === "SUCCEEDED") return refund;
    }
  }

  try {
    const res = await provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountAgorot: refund.amountAgorot,
      idempotencyKey: key,
      reason,
    });
    if (res.status !== "SUCCEEDED") throw new Error("refund_not_succeeded");
    const done = await prisma.$transaction(async (tx) => {
      const updated = await tx.refund.update({
        where: { id: refund!.id },
        data: { status: "SUCCEEDED", providerRefundId: res.providerRefundId },
      });
      if (payment.appointmentId) {
        await tx.appointment.update({ where: { id: payment.appointmentId }, data: { paymentStatus: "REFUNDED" } });
      }
      return updated;
    });
    await audit(payment.id, "refund", "ok");
    return done;
  } catch (err) {
    await audit(payment.id, "refund", "error", err instanceof Error ? err.name : "unknown");
    throw err;
  }
}

// ───────────────────────────── ביטול ─────────────────────────────

export type CancelOutcome =
  | "ALREADY_CANCELLED"
  | "HOLD_CANCELLED"
  | "CANCELLED_NO_PAYMENT"
  | "REFUNDED"
  | "MINUTES_RESTORED"
  | "CANCELLED_NO_REFUND"
  | "CANCELLED_REFUND_PENDING";

export interface CancelResult {
  outcome: CancelOutcome;
  /** דקות שחזרו למקור שעדיין בתוקף */
  minutesRestored: number;
  /** דקות שהפכו לזיכוי של 30 יום (המקור פג) */
  creditedMinutes: number;
  /** חוב פתוח שבוטל בעקבות ביטול מוקדם */
  debtWaived: boolean;
}

const noRestore = { minutesRestored: 0, creditedMinutes: 0, debtWaived: false };

/**
 * מבטל הזמנה. החזקה: מבוטלת והתשלום הממתין מבוטל (לא נוצל דבר, לכן אין מה להחזיר).
 * הזמנה מאושרת: ביטול לפחות 24 שעות לפני ההתחלה (בדיוק 24 מזכה), או חריג מנהל, מחזיר את הדקות שנוצלו מיתרה
 * (אל המקור אם בתוקף, אחרת לזיכוי של 30 יום מרגע הביטול), מחזיר את התשלום בכסף, ומבטל חוב משויך.
 * ביטול מאוחר מבטל את ההזמנה בלי החזר ובלי להחזיר דקות; מנהל יכול לאשר חריג אחר כך (approveCancellationRefund).
 */
export async function cancelBooking(params: {
  appointmentId: string;
  requester: { id: string; role: string };
  provider: PaymentProvider;
  now?: Date;
  /** חריג מנהל: מתייחס לביטול כאילו בוצע מוקדם. נתמך רק למבקש מנהל */
  adminException?: boolean;
}): Promise<CancelResult> {
  const { appointmentId, requester, provider, now = new Date(), adminException = false } = params;
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { room: true } });
  const isAdmin = requester.role === "ADMIN";
  if (!appt || (!isAdmin && appt.userId !== requester.id)) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  if (appt.status === "CANCELLED") return { outcome: "ALREADY_CANCELLED", ...noRestore };
  // מופע של משמרת קבועה אינו מבוטל כאן: מסלול המשמרות הוא היחיד שמטפל בחיוב ובהחזר שלו
  if ((await prisma.shiftOccurrence.count({ where: { appointmentId } })) > 0) {
    throw new PaymentFlowError("זהו מופע של משמרת קבועה. שינוי או ביטול מחייבים אישור מנהל", "CONFLICT");
  }

  const eligible = isAutoRefundEligible({ startTime: appt.startTime, now, adminException: isAdmin && adminException });

  const cancelled = await prisma.$transaction(async (tx) => {
    await lockRoomZone(tx, appt.room.key);
    await lockAppointmentRow(tx, appt.id);
    const { count } = await tx.appointment.updateMany({
      where: { id: appt.id, status: { in: ["CONFIRMED", "PENDING_PAYMENT"] } },
      data: { status: "CANCELLED", holdExpiresAt: null },
    });
    if (count !== 1) return null;
    if (appt.status !== "CONFIRMED" || !eligible) return noRestore;

    // ההחזרה והביטול אטומיים: אם אחד נכשל שניהם מתבטלים, ואי אפשר להחזיר פעמיים
    await lockUserBalances(tx, appt.userId);
    const restored = await restoreAppointmentBalance(tx, { userId: appt.userId, appointmentId: appt.id, now });
    const debtWaived = await waiveOpenDebtForAppointment(tx, appt.id, requester.id, now, "cancellation_24h_or_more");
    return { minutesRestored: restored.restoredMinutes, creditedMinutes: restored.creditedMinutes, debtWaived };
  });
  if (!cancelled) return { outcome: "ALREADY_CANCELLED", ...noRestore };

  if (appt.status === "PENDING_PAYMENT") {
    await cancelPendingPayments(appt.id, provider, now);
    return { outcome: "HOLD_CANCELLED", ...noRestore };
  }

  const paid = await prisma.payment.findFirst({ where: { appointmentId: appt.id, purpose: "BOOKING", status: "SUCCEEDED" } });
  if (!paid && appt.paidFromBalanceMinutes === 0) return { outcome: "CANCELLED_NO_PAYMENT", ...cancelled };
  if (!eligible) return { outcome: "CANCELLED_NO_REFUND", ...cancelled };
  if (!paid) return { outcome: "MINUTES_RESTORED", ...cancelled };

  try {
    await refundPaymentFull({ paymentId: paid.id, provider, reason: "cancellation_24h_or_more" });
    return { outcome: "REFUNDED", ...cancelled };
  } catch (err) {
    console.error("[payments] cancellation refund failed", err instanceof Error ? err.message : "unknown");
    return { outcome: "CANCELLED_REFUND_PENDING", ...cancelled };
  }
}

/**
 * מנהל מאשר חריג להזמנה שבוטלה: מחזיר דקות שנוצלו (אם טרם הוחזרו), מחזיר את התשלום בכסף, ואופציונלית מוותר על
 * החוב המשויך. אידמפוטנטי: אין החזר כפול של כסף או דקות, גם אם הביטול כבר היה מוקדם.
 */
export async function approveCancellationRefund(params: {
  appointmentId: string;
  adminId: string;
  provider: PaymentProvider;
  waiveDebt?: boolean;
  now?: Date;
}) {
  const { appointmentId, adminId, provider, waiveDebt = false, now = new Date() } = params;
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { role: true } });
  if (admin?.role !== "ADMIN") throw new PaymentFlowError("פעולה למנהל בלבד", "FORBIDDEN");

  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { debt: true } });
  if (!appt) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  if (appt.status !== "CANCELLED") throw new PaymentFlowError("ניתן לאשר חריג רק להזמנה מבוטלת", "CONFLICT");
  const paid = await prisma.payment.findFirst({ where: { appointmentId, purpose: "BOOKING", status: "SUCCEEDED" } });
  const hasOpenDebt = appt.debt?.status === "OPEN" || appt.debt?.status === "IN_REVIEW";
  if (!paid && appt.paidFromBalanceMinutes === 0 && !(waiveDebt && hasOpenDebt)) {
    throw new PaymentFlowError("אין תשלום, דקות או חוב לטיפול בהזמנה זו", "NOT_FOUND");
  }

  const handled = await prisma.$transaction(async (tx) => {
    await lockAppointmentRow(tx, appt.id);
    await lockUserBalances(tx, appt.userId);
    const restored = await restoreAppointmentBalance(tx, { userId: appt.userId, appointmentId: appt.id, now });
    let debtWaived = false;
    if (waiveDebt) {
      debtWaived = await waiveOpenDebtForAppointment(tx, appt.id, adminId, now, "admin_approved_exception");
    }
    return { minutesRestored: restored.restoredMinutes, creditedMinutes: restored.creditedMinutes, debtWaived };
  });

  const refund = paid ? await refundPaymentFull({ paymentId: paid.id, provider, reason: "admin_approved_exception", createdById: adminId }) : null;
  return { refund, ...handled };
}

/** מבטל תשלומים ממתינים של הזמנה. אם הספק כבר גבה (לא ניתן לבטל), מפעיל אימות שיחזיר את הכסף */
async function cancelPendingPayments(appointmentId: string, provider: PaymentProvider, now: Date) {
  const pending = await prisma.payment.findMany({ where: { appointmentId, purpose: "BOOKING", status: "PENDING" } });
  for (const p of pending) {
    try {
      if (p.providerPaymentId) await provider.cancelPayment(p.providerPaymentId);
      await prisma.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      await audit(p.id, "cancel", "ok");
    } catch {
      await audit(p.id, "cancel", "error", "cancel_rejected");
      try {
        await finalizeBookingPayment({ paymentId: p.id, provider, now });
      } catch (err) {
        console.error("[payments] finalize after failed cancel", err instanceof Error ? err.message : "unknown");
      }
    }
  }
}

// ───────────────────────────── ניקוי והתאמה ─────────────────────────────

/** מבטל החזקות שפגו. לא תנאי לזמינות (פקיעה נבדקת מול הזמן); זה רק סדר בנתונים. בטוח להרצה מקבילית וחוזרת */
export async function expireStaleHolds(params: { provider: PaymentProvider; now?: Date }) {
  const { provider, now = new Date() } = params;
  const stale = await prisma.appointment.findMany({
    where: { status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
    select: { id: true },
  });
  let expired = 0;
  for (const { id } of stale) {
    const { count } = await prisma.appointment.updateMany({
      where: { id, status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
      data: { status: "CANCELLED", holdExpiresAt: null },
    });
    expired += count;
    await cancelPendingPayments(id, provider, now);
  }
  return { expired };
}

// ───────────────────────────── שיגור לפי סוג תשלום ─────────────────────────────

export type AnyFinalizeResult = FinalizeResult | PackageFinalizeResult;

/** מאמת ומסיים תשלום לפי מטרתו: הזמנה או רכישת חבילה */
export async function finalizePayment(params: {
  paymentId: string;
  provider: PaymentProvider;
  now?: Date;
}): Promise<AnyFinalizeResult> {
  const payment = await prisma.payment.findUnique({ where: { id: params.paymentId }, select: { purpose: true } });
  if (!payment) throw new PaymentFlowError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.purpose === "BOOKING") return finalizeBookingPayment(params);
  if (payment.purpose === "PACKAGE") return finalizePackagePayment(params);
  throw new PaymentFlowError("סוג תשלום לא נתמך", "INVALID");
}

/**
 * מתאם תשלומים שנתקעו במצב ממתין (webhook שלא הגיע, קריסה בין אישור הספק לעדכון, או קריסה לפני שמירת מזהה הספק).
 * מיועד להרצה תקופתית בעתיד; עדיין לא מחובר לשום Cron.
 */
export async function reconcilePendingPayments(params: { provider: PaymentProvider; olderThanMs?: number; now?: Date; limit?: number }) {
  const { provider, olderThanMs = 60_000, now = new Date(), limit = 100 } = params;
  const candidates = await prisma.payment.findMany({
    where: {
      purpose: { in: ["BOOKING", "PACKAGE"] },
      status: "PENDING",
      provider: provider.name,
      environment: environmentOf(provider),
      createdAt: { lte: new Date(now.getTime() - olderThanMs) },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const results: AnyFinalizeResult[] = [];
  const errors: string[] = [];
  for (const p of candidates) {
    try {
      if (!p.providerPaymentId && p.paymentMethodId) {
        // חיוב באמצעי שמור שנקטע לפני שנשמרה תוצאת הספק. לא מחייבים מחדש בלי הרשאת לקוח חדשה ולא פותחים עמוד תשלום:
        // סוגרים כנכשל, והלקוח יתחיל מחדש. (התאמה מול הספק לפי מפתח אידמפוטנטיות תתאפשר רק אחרי אימות יכולות הספק האמיתי)
        await prisma.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "FAILED", failureCode: "interrupted" } });
        await audit(p.id, "charge", "error", "interrupted");
        continue;
      }
      if (!p.providerPaymentId) {
        // לא נשמר מזהה הספק: ניסיון אידמפוטנטי לאחזר אותו (אם הבקשה לספק לא נוצרה, ייווצר עכשיו)
        const req = await provider.createPaymentRequest({
          amountAgorot: p.amountAgorot,
          currency: "ILS",
          description: p.purpose === "PACKAGE" ? `רכישת חבילת ${p.packageHours} שעות` : "תשלום על הזמנת חדר",
          idempotencyKey: p.idempotencyKey,
          customerRef: p.userId,
          metadata: p.appointmentId ? { appointmentId: p.appointmentId } : { packageHours: String(p.packageHours) },
        });
        await prisma.payment.updateMany({ where: { id: p.id, providerPaymentId: null }, data: { providerPaymentId: req.providerPaymentId } });
      }
      results.push(await finalizePayment({ paymentId: p.id, provider, now }));
    } catch (err) {
      errors.push(`${p.id}: ${err instanceof Error ? err.name : "error"}`);
    }
  }
  return { results, errors };
}

// ───────────────────────────── webhook ─────────────────────────────

export type WebhookOutcome = "PROCESSED" | "DUPLICATE" | "DEFERRED" | "IGNORED";

/**
 * מעבד התראת ספק. החתימה מאומתת בספק (זורק WebhookVerificationError). ההתראה היא טריגר בלבד: הסטטוס נשלף שוב
 * מהספק. כפילות מזוהה לפי (provider, eventId). אירוע שהתשלום שלו עדיין לא ידוע אצלנו נשאר לא מעובד (DEFERRED)
 * כדי שניסיון חוזר של הספק או reconcile יטפלו בו.
 */
export async function handlePaymentWebhook(params: {
  provider: PaymentProvider;
  rawBody: string;
  headers: Record<string, string | undefined>;
  now?: Date;
}): Promise<{ outcome: WebhookOutcome; finalize?: AnyFinalizeResult }> {
  const { provider, rawBody, headers, now } = params;
  const event = await provider.parseWebhook({ rawBody, headers });

  try {
    await prisma.webhookEvent.create({ data: { provider: provider.name, eventId: event.eventId, type: event.type } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: provider.name, eventId: event.eventId } },
    });
    if (existing?.processedAt) return { outcome: "DUPLICATE" };
  }

  const markProcessed = () =>
    prisma.webhookEvent.updateMany({
      where: { provider: provider.name, eventId: event.eventId, processedAt: null },
      data: { processedAt: new Date() },
    });

  if (event.type !== "payment.updated") {
    await markProcessed();
    return { outcome: "IGNORED" };
  }

  const payment = await prisma.payment.findFirst({
    where: { provider: provider.name, providerPaymentId: event.providerPaymentId, environment: environmentOf(provider) },
  });
  if (!payment) return { outcome: "DEFERRED" };

  const finalize = await finalizePayment({ paymentId: payment.id, provider, now });
  await markProcessed();
  return { outcome: "PROCESSED", finalize };
}

// ───────────────────────────── הזמנת מנהל עם חוב ─────────────────────────────

/**
 * מנהל יוצר הזמנה מאושרת ללא תשלום מיידי, עם חוב פתוח בסכום המחיר הרגיל. עוברת את אותן בדיקות זמינות ונעילות
 * וההחזקה של 10 דקות, אך מושלמת מיד. חוב פתוח אינו חוסם את הלקוח אוטומטית. אינה משתמשת ביתרות הלקוח.
 */
export async function createAdminBookingWithDebt(params: {
  adminId: string;
  userId: string;
  roomKey: RoomKey;
  startTime: Date;
  endTime: Date;
  notes?: string;
  reason?: string;
  now?: Date;
  /** רץ בתוך אותה טרנזקציה שמאשרת את ההזמנה ויוצרת את החוב (למשל רישום ביומן ביקורת): נכשל = הכול מתבטל */
  onCreated?: (tx: Tx, created: { appointmentId: string; debtId: string; amountAgorot: number }) => Promise<void>;
}) {
  const { adminId, userId, roomKey, startTime, endTime, notes, reason, now = new Date(), onCreated } = params;
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { role: true } });
  if (admin?.role !== "ADMIN") throw new PaymentFlowError("פעולה למנהל בלבד", "FORBIDDEN");
  const customer = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!customer) throw new PaymentFlowError("הלקוח לא נמצא", "NOT_FOUND");

  const hold = await createBookingHold({ userId, roomKey, startTime, endTime, notes, source: "ADMIN", now });
  const amountAgorot = priceFor(hold);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockRoomZone(tx, roomKey);
      await lockAppointmentRow(tx, hold.id);
      const appt = await tx.appointment.findUniqueOrThrow({ where: { id: hold.id } });
      if (appt.status === "CONFIRMED" && appt.paymentStatus === "DEBT") {
        return { appointment: appt, debt: await tx.debt.findUnique({ where: { appointmentId: appt.id } }) };
      }
      assertActiveHold(appt, now);
      const appointment = await tx.appointment.update({
        where: { id: appt.id },
        data: { status: "CONFIRMED", holdExpiresAt: null, paymentStatus: "DEBT" },
      });
      const debt = await tx.debt.create({
        data: { userId, appointmentId: appt.id, amountAgorot, reason: reason ?? "הזמנת מנהל ללא תשלום", createdById: adminId },
      });
      if (onCreated) await onCreated(tx, { appointmentId: appt.id, debtId: debt.id, amountAgorot });
      return { appointment, debt };
    });
  } catch (err) {
    await prisma.appointment.updateMany({
      where: { id: hold.id, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", holdExpiresAt: null },
    });
    throw err;
  }
}

// ───────────────────────────── חיוב אמצעי תשלום שמור ─────────────────────────────

/**
 * חיוב אמצעי תשלום שמור (בטלפון: אחרי אימות קוד והרשאה חד-פעמית) על גבי אותו מנגנון: אותו Payment, אותו
 * finalizeBookingPayment. הוא שמאשר את ההזמנה, מנכה את הדקות בתשלום משולב, ומחזיר כסף בתשלום מאוחר או כשהיתרה השתנתה.
 *
 *  - expected: החלוקה שהוצגה ללקוח ואושרה. אם היתרה השתנתה והחלוקה שונה, לא מחייבים (PLAN_CHANGED).
 *  - אידמפוטנטי: ניסיון חוזר משתמש באותו Payment ובאותו מפתח מול הספק ולכן לא מחייב פעמיים.
 *  - שגיאת ספק לא ברורה (לא ידוע אם חויב) נסגרת כנכשלת ללא ניסיון חוזר אוטומטי.
 * הטוקן עובר רק לספק ואינו נרשם או מוחזר.
 */
export async function payBookingWithSavedCard(params: {
  appointmentId: string;
  userId: string;
  provider: PaymentProvider;
  expected: { cashAgorot: number; packageMinutes: number };
  now?: Date;
  /** נקודת הזרקה לבדיקות בלבד (כמו ב-finalizeBookingPayment) */
  hooks?: { beforeApply?: () => Promise<void> };
}): Promise<FinalizeResult> {
  const { appointmentId, userId, provider, expected, now = new Date(), hooks } = params;

  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt || appt.userId !== userId) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");
  assertActiveHold(appt, now);

  const plan = await planFor(appt, userId, now, true);
  if (plan.cashAgorot !== expected.cashAgorot || plan.packageMinutes !== expected.packageMinutes) {
    throw new PaymentFlowError("חלוקת התשלום השתנתה מאז שאושרה", "PLAN_CHANGED");
  }
  if (plan.cashAgorot === 0) throw new PaymentFlowError("אין סכום לחיוב בכסף; יש לאשר מהיתרה", "INVALID");

  const card = await findUsableCard(userId, provider);
  if (!card) throw new PaymentFlowError("אין אמצעי תשלום שמור שניתן לחייב", "NO_PAYMENT_METHOD");

  let payment: Payment | undefined;
  for (let attempt = 0; attempt < 3 && !payment; attempt++) {
    const found = await ensurePendingPayment({ appointmentId, userId, plan, provider, now, paymentMethodId: card.id });
    if (!found.stale) payment = found.payment;
    else await retireStalePayment(found.stale, provider, now);
  }
  if (!payment) throw new PaymentFlowError("לא ניתן לפתוח תשלום כעת, נסו שוב", "CONFLICT");

  if (!payment.providerPaymentId) {
    let charge;
    try {
      charge = await provider.chargeSavedMethod({
        token: card.token,
        amountAgorot: payment.amountAgorot,
        currency: "ILS",
        description: "תשלום על הזמנת חדר",
        idempotencyKey: payment.idempotencyKey,
        customerRef: userId,
        metadata: { appointmentId },
      });
    } catch (err) {
      await prisma.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", failureCode: "provider_error" } });
      await audit(payment.id, "charge", "error", err instanceof Error ? err.name : "unknown");
      throw new PaymentFlowError("שגיאה בספק התשלום", "PROVIDER_ERROR");
    }
    await prisma.payment.updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { providerPaymentId: charge.providerPaymentId } });
    await audit(payment.id, "charge", "ok");
  }
  return finalizeBookingPayment({ paymentId: payment.id, provider, now, beforeApply: hooks?.beforeApply });
}

export { BookingError };
