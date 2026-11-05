import type { PrismaClient, ShiftCharge } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { jerusalemDayStart, jerusalemTodayIso } from "@/lib/jerusalem-time";
import type { PaymentProvider } from "@/lib/payments/provider";
import { findUsableCard } from "@/lib/payments/saved-methods";
import { audit, environmentOf, isUniqueViolation } from "@/lib/payments/shared";
import { billingDueDates, billingMonths, monthKeyOf } from "@/lib/shifts/calendar";
import { writeAudit } from "@/lib/finance/audit";
import { CHARGE_CLAIM_TTL_MS, CRON_STALE_RUN_MS, MAKEUP_CREDIT_VALIDITY_DAYS, PENDING_SHIFT_MAX_HOLD_MS, SHIFT_BILLING_JOB, SHIFT_GRACE_DAYS } from "@/lib/shifts/policy";

/**
 * חיוב חודשי של משמרות: בדיוק שלושה חיובים, במועדים שמחושבים מתאריך ההתחלה (calendar.ts). שורה אחת ב-ShiftCharge לכל
 * (משמרת, מפתח חודש) -> אי אפשר לחייב פעמיים עבור אותו חיוב (אילוץ ייחודיות במסד), ולא נסמכים על תזמון לצורך אידמפוטנטיות.
 * כל ניסיון מקבל מפתח יציב מול הספק (shiftcharge:<shift>:<month>:a<N>) ונרשם ב-Payment. הסכום הוא תמיד המחיר החודשי הקבוע
 * של המשמרת (בלי חישוב יחסי). משמרת ישנה שתומחרה לפי מופע (monthlyPriceAgorot = 0) ממשיכה להתחשבן לפי המופעים בחודש.
 * משמרת בתשלום ידני (MANUAL) לעולם אינה מחויבת אוטומטית: רק מנהל מתעד תשלום (recordManualPayment).
 *
 * הבחנה חשובה: כישלון ודאי (נדחה/אין אמצעי) פותח תקופת חסד ומאפשר ניסיון חוזר חדש; מצב לא ידוע (שגיאת רשת, תשובה
 * עמומה, ריצה שנקטעה באמצע) הופך ל-UNKNOWN ואינו מחויב שוב אוטומטית עד בירור/התאמה.
 */

const DAY_MS = 24 * 3600_000;

export type ChargeOutcome =
  | "PAID"
  | "FAILED"
  | "UNKNOWN"
  | "ALREADY_PAID"
  | "NEEDS_REVIEW"
  | "IN_PROGRESS"
  | "NOTHING_DUE"
  | "NOT_BILLABLE"
  /** כישלון קודם בתקופת חסד; לא נוסה שוב בריצה זו */
  | "ALREADY_FAILED";

export interface ChargeResult {
  outcome: ChargeOutcome;
  chargeId?: string;
  amountAgorot?: number;
  failureCode?: string;
}

export const chargeKey = (shiftId: string, month: string, attempt: number) => `shiftcharge:${shiftId}:${month}:a${attempt}`;

export function graceDeadline(from: Date): Date {
  return new Date(from.getTime() + SHIFT_GRACE_DAYS * DAY_MS);
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** מחשב את הסכום והמספר מהמופעים המתוזמנים בפועל בחודש */
async function monthTotals(db: Tx | PrismaClient, shiftId: string, month: string) {
  const agg = await db.shiftOccurrence.aggregate({
    where: { shiftId, month, status: "SCHEDULED" },
    _sum: { priceAgorot: true },
    _count: true,
  });
  return { amountAgorot: agg._sum.priceAgorot ?? 0, count: agg._count };
}

type Claim =
  | { kind: "result"; result: ChargeResult }
  | { kind: "go"; charge: ShiftCharge; userId: string; paymentMethodId: string | null }
  | { kind: "recover"; charge: ShiftCharge; userId: string };

/**
 * שלב א': תפיסה. בטרנזקציה קצרה, תחת נעילת שורת המשמרת, קובעים אם מותר לחייב ומסמנים תפיסה (claimedAt, attempt).
 * שתי ריצות מקבילות לאותו (משמרת, חודש) מסודרות בטור, והשנייה רואה תפיסה פעילה ויוצאת.
 */
async function claimCharge(
  db: PrismaClient,
  p: { shiftId: string; month: string; isFirst: boolean; retry: boolean; now: Date }
): Promise<Claim> {
  const { shiftId, month, isFirst, retry, now } = p;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shiftId} FOR UPDATE`;
    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!shift) return { kind: "result", result: { outcome: "NOT_BILLABLE" } } as Claim;
    if (!(shift.status === "ACTIVE" || (isFirst && shift.status === "PENDING"))) {
      return { kind: "result", result: { outcome: "NOT_BILLABLE" } } as Claim;
    }
    if (shift.paymentMode === "MANUAL") return { kind: "result", result: { outcome: "NOT_BILLABLE" } } as Claim;

    const fixed = shift.monthlyPriceAgorot > 0;
    const amountOf = (t: { amountAgorot: number }) => (fixed ? shift.monthlyPriceAgorot : t.amountAgorot);
    const dueDate = billingDueDates(shift.startDate)[billingMonths(shift.startDate).indexOf(month)] ?? null;
    const totals = await monthTotals(tx, shiftId, month);
    let charge = await tx.shiftCharge.findUnique({ where: { shiftId_month: { shiftId, month } } });

    if (charge) {
      if (charge.status === "PAID" || charge.status === "WAIVED") {
        return { kind: "result", result: { outcome: "ALREADY_PAID", chargeId: charge.id } };
      }
      if (charge.status === "UNKNOWN") return { kind: "result", result: { outcome: "NEEDS_REVIEW", chargeId: charge.id } };
      if (charge.status === "FAILED" && !retry) {
        return { kind: "result", result: { outcome: "ALREADY_FAILED", chargeId: charge.id, failureCode: charge.failureCode ?? undefined } };
      }
      if (charge.status === "PENDING" && charge.claimedAt && now.getTime() - charge.claimedAt.getTime() < CHARGE_CLAIM_TTL_MS) {
        return { kind: "result", result: { outcome: "IN_PROGRESS", chargeId: charge.id } };
      }
    } else {
      if (!fixed && totals.count === 0) {
        // אין מופעים בחודש הזה: אין מה לחייב. שורה מאופסת מתעדת שהחודש טופל
        const zero = await tx.shiftCharge.create({
          data: { shiftId, month, amountAgorot: 0, occurrenceCount: 0, isFirst, status: "WAIVED", note: "no_occurrences", paidAt: now },
        });
        return { kind: "result", result: { outcome: "NOTHING_DUE", chargeId: zero.id, amountAgorot: 0 } };
      }
      charge = await tx.shiftCharge.create({
        data: { shiftId, month, dueDate, amountAgorot: amountOf(totals), occurrenceCount: totals.count, isFirst, status: "PENDING" },
      });
    }

    // ריצה קודמת שנקטעה (תפיסה ישנה) או כישלון שמנסים שוב. קודם בודקים אם ניסיון קודם כבר הגיע לספק
    const previousAttemptKey = charge.attempt > 0 ? chargeKey(shiftId, month, charge.attempt) : null;
    if (charge.status === "PENDING" && previousAttemptKey) {
      const prior = await tx.payment.findUnique({ where: { idempotencyKey: previousAttemptKey } });
      if (prior) {
        // כבר נוצר תשלום לניסיון הקודם: אסור לחייב מחדש בעיוורון. מבררים מול הספק במקום
        await tx.shiftCharge.update({ where: { id: charge.id }, data: { claimedAt: now } });
        return { kind: "recover", charge, userId: shift.userId };
      }
    }

    const recomputed = await monthTotals(tx, shiftId, month);
    if (!fixed && recomputed.count === 0) {
      await tx.shiftCharge.update({ where: { id: charge.id }, data: { status: "WAIVED", amountAgorot: 0, occurrenceCount: 0, note: "no_occurrences", paidAt: now } });
      return { kind: "result", result: { outcome: "NOTHING_DUE", chargeId: charge.id, amountAgorot: 0 } };
    }
    // ניסיון חוזר אחרי כישלון ודאי מקבל מספר ניסיון חדש (מפתח חדש מול הספק). תפיסה ישנה בלי תשלום משתמשת שוב באותו מספר
    const attempt = charge.status === "FAILED" ? charge.attempt + 1 : Math.max(charge.attempt, 1);
    const claimed = await tx.shiftCharge.update({
      where: { id: charge.id },
      data: {
        status: "PENDING",
        attempt,
        claimedAt: now,
        lastAttemptAt: now,
        amountAgorot: amountOf(recomputed),
        occurrenceCount: recomputed.count,
        // החיוב הראשון נקבע בעת ההזמנה (לא בתאריך ההתחלה): לא דורסים מועד שכבר נשמר
        dueDate: charge.dueDate ?? dueDate,
        failureCode: null,
        paymentId: null,
      },
    });
    return { kind: "go", charge: claimed, userId: shift.userId, paymentMethodId: shift.paymentMethodId };
  });
}

async function markFailed(db: PrismaClient, chargeId: string, failureCode: string, now: Date, paymentId?: string) {
  const current = await db.shiftCharge.findUniqueOrThrow({ where: { id: chargeId } });
  await db.shiftCharge.update({
    where: { id: chargeId },
    data: {
      status: "FAILED",
      failureCode,
      claimedAt: null,
      // תקופת החסד מתחילה בכישלון הראשון ואינה מתארכת בניסיונות חוזרים
      graceUntil: current.graceUntil ?? graceDeadline(now),
      ...(paymentId ? { paymentId } : {}),
    },
  });
  if (paymentId) await db.payment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "FAILED", failureCode } });
}

async function markUnknown(db: PrismaClient, chargeId: string, code: string, paymentId?: string) {
  await db.shiftCharge.update({ where: { id: chargeId }, data: { status: "UNKNOWN", failureCode: code, claimedAt: null, ...(paymentId ? { paymentId } : {}) } });
  if (paymentId) await audit(paymentId, "charge", "error", code);
}

async function markPaid(db: PrismaClient, chargeId: string, paymentId: string, now: Date) {
  await db.$transaction([
    db.payment.updateMany({ where: { id: paymentId, status: { not: "SUCCEEDED" } }, data: { status: "SUCCEEDED", paidAt: now, failureCode: null } }),
    db.shiftCharge.update({ where: { id: chargeId }, data: { status: "PAID", paidAt: now, claimedAt: null, failureCode: null, graceUntil: null, paymentId } }),
  ]);
}

/** מאמת מול הספק (בצד השרת) תשלום שכבר קיים, ומסדר את מצב החיוב לפיו. משמש להתאוששות מריצה שנקטעה */
async function settleFromProvider(db: PrismaClient, provider: PaymentProvider, charge: ShiftCharge, paymentId: string, providerPaymentId: string, now: Date): Promise<ChargeResult> {
  let verified;
  try {
    verified = await provider.getPaymentStatus(providerPaymentId);
  } catch {
    await markUnknown(db, charge.id, "status_check_failed", paymentId);
    return { outcome: "UNKNOWN", chargeId: charge.id, amountAgorot: charge.amountAgorot };
  }
  if (verified.providerPaymentId !== providerPaymentId || verified.amountAgorot !== charge.amountAgorot) {
    await markUnknown(db, charge.id, "amount_mismatch", paymentId);
    return { outcome: "UNKNOWN", chargeId: charge.id, amountAgorot: charge.amountAgorot };
  }
  if (verified.status === "SUCCEEDED") {
    await markPaid(db, charge.id, paymentId, now);
    return { outcome: "PAID", chargeId: charge.id, amountAgorot: charge.amountAgorot };
  }
  if (verified.status === "FAILED" || verified.status === "CANCELLED") {
    await markFailed(db, charge.id, verified.failureCode ?? "card_declined", now, paymentId);
    return { outcome: "FAILED", chargeId: charge.id, amountAgorot: charge.amountAgorot, failureCode: verified.failureCode ?? "card_declined" };
  }
  await markUnknown(db, charge.id, "pending_at_provider", paymentId);
  return { outcome: "UNKNOWN", chargeId: charge.id, amountAgorot: charge.amountAgorot };
}

/**
 * מחייב חודש אחד של משמרת באמצעי התשלום השמור. אידמפוטנטי ובטוח להפעלה חוזרת/מקבילית (ראו claimCharge). שלב ב' (הקריאה
 * לספק) מתבצע מחוץ לטרנזקציה, ותוצאתו מאומתת מול הספק בצד השרת.
 * retry: מותר רק לניסיון חוזר מכוון אחרי כישלון ודאי (ריצת retry של ה-Cron או פעולת מנהל).
 */
export async function chargeShiftMonth(params: {
  shiftId: string;
  month: string;
  provider: PaymentProvider;
  isFirst?: boolean;
  retry?: boolean;
  now?: Date;
  db?: PrismaClient;
}): Promise<ChargeResult> {
  const { shiftId, month, provider, isFirst = false, retry = false, now = new Date(), db = defaultDb } = params;

  const claim = await claimCharge(db, { shiftId, month, isFirst, retry, now });
  if (claim.kind === "result") return claim.result;

  if (claim.kind === "recover") {
    const payment = await db.payment.findUniqueOrThrow({ where: { idempotencyKey: chargeKey(shiftId, month, claim.charge.attempt) } });
    if (!payment.providerPaymentId) {
      // התשלום נוצר, אך לא ידוע אם הבקשה הגיעה לספק: מצב לא ידוע, בלי חיוב חוזר
      await markUnknown(db, claim.charge.id, "interrupted", payment.id);
      return { outcome: "UNKNOWN", chargeId: claim.charge.id, amountAgorot: claim.charge.amountAgorot };
    }
    return settleFromProvider(db, provider, claim.charge, payment.id, payment.providerPaymentId, now);
  }

  const { charge } = claim;
  const key = chargeKey(shiftId, month, charge.attempt);

  // אמצעי התשלום: המועדף של המשמרת אם עדיין שמיש, אחרת כל אמצעי שמיש של הלקוח. לעולם לא כרטיס שאינו שמיש
  let card = null;
  const preferred = claim.paymentMethodId
    ? await db.paymentMethod.findFirst({ where: { id: claim.paymentMethodId, userId: claim.userId, active: true } })
    : null;
  if (preferred && provider.isPaymentMethodUsable && preferred.provider === provider.name && preferred.environment === environmentOf(provider)) {
    if (await provider.isPaymentMethodUsable(preferred.token)) card = { id: preferred.id, token: preferred.token };
  }
  card ??= await findUsableCard(claim.userId, provider, db);
  if (!card) {
    await markFailed(db, charge.id, "no_usable_method", now);
    return { outcome: "FAILED", chargeId: charge.id, amountAgorot: charge.amountAgorot, failureCode: "no_usable_method" };
  }

  let payment;
  try {
    payment = await db.payment.create({
      data: {
        userId: claim.userId,
        purpose: "SHIFT_MONTH",
        amountAgorot: charge.amountAgorot,
        status: "PENDING",
        environment: environmentOf(provider),
        provider: provider.name,
        idempotencyKey: key,
        paymentMethodId: card.id,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // תשלום לאותו ניסיון כבר קיים (ריצה אחרת): לא מחייבים שוב, מבררים
    await db.shiftCharge.update({ where: { id: charge.id }, data: { status: "UNKNOWN", failureCode: "duplicate_attempt", claimedAt: null } });
    return { outcome: "UNKNOWN", chargeId: charge.id, amountAgorot: charge.amountAgorot };
  }
  await db.shiftCharge.update({ where: { id: charge.id }, data: { paymentId: payment.id } });

  let res;
  try {
    res = await provider.chargeSavedMethod({
      token: card.token,
      amountAgorot: charge.amountAgorot,
      currency: "ILS",
      description: `חיוב משמרת קבועה ${month}`,
      idempotencyKey: key,
      customerRef: claim.userId,
      metadata: { shiftId, month },
    });
  } catch (err) {
    // לא ידוע אם בוצע חיוב: UNKNOWN, ללא ניסיון אוטומטי נוסף
    await markUnknown(db, charge.id, err instanceof Error ? err.name : "provider_error", payment.id);
    return { outcome: "UNKNOWN", chargeId: charge.id, amountAgorot: charge.amountAgorot };
  }
  await db.payment.updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { providerPaymentId: res.providerPaymentId } });
  await audit(payment.id, "charge", "ok");

  return settleFromProvider(db, provider, { ...charge, paymentId: payment.id }, payment.id, res.providerPaymentId, now);
}

// ───────────────────────────── סריקה והרצה חודשית ─────────────────────────────

export interface DueCharge {
  shiftId: string;
  month: string;
  /** MISSED = חיוב שמועדו עבר ועדיין לא חויב (הריצה היומית הוחמצה) */
  kind: "MONTHLY" | "MISSED";
}

export function currentMonthKey(now: Date): string {
  return monthKeyOf(jerusalemTodayIso(now));
}

/**
 * סריקה בלבד (ללא כתיבה וללא חיוב): אילו חיובים חודשיים יש לבצע. כוללת חודשים שהוחמצו. חודשים שכבר שולמו/אופסו,
 * חיובים שנכשלו (ממתינים לריצת retry) וחיובים במצב לא ידוע אינם נכללים.
 */
export async function scanDueCharges(db: PrismaClient, now: Date): Promise<{ due: DueCharge[]; needsReview: number }> {
  const today = jerusalemTodayIso(now);
  // משמרת בתשלום ידני אינה מחויבת אוטומטית (המנהל מתעד תשלום)
  const shifts = await db.shift.findMany({ where: { status: "ACTIVE", paymentMode: "AUTO" }, include: { charges: true } });
  const due: DueCharge[] = [];
  let needsReview = 0;
  for (const shift of shifts) {
    const months = billingMonths(shift.startDate);
    const dueDates = billingDueDates(shift.startDate);
    for (const [index, month] of months.entries()) {
      // החיוב הראשון של משמרת במחיר חודשי קבוע מתבצע רק בעת ההזמנה (createShift), לא בריצה היומית
      if (index === 0 && shift.monthlyPriceAgorot > 0) continue;
      // החיוב מגיע במועדו המלא (לא בתחילת החודש הקלנדרי)
      if (dueDates[index] > today) continue;
      const charge = shift.charges.find((c) => c.month === month);
      if (charge?.status === "UNKNOWN") needsReview++;
      if (charge && charge.status !== "PENDING") continue;
      due.push({ shiftId: shift.id, month, kind: dueDates[index] < today ? "MISSED" : "MONTHLY" });
    }
  }
  return { due, needsReview };
}

export interface BillingRunSummary {
  period: string;
  scanned: number;
  charged: number;
  failed: number;
  unknown: number;
  skipped: number;
  retried: number;
  retriedPaid: number;
  suspended: number;
  ended: number;
  /** משמרות שהמתינו לאישור חיוב ראשון מעבר לזמן המותר: אושרו / שוחררו */
  pendingActivated: number;
  pendingReleased: number;
  /** חיובים ידניים שלא התקבלו במועד ונכנסו לתקופת חסד */
  manualOverdue: number;
  /** זיכויי שעות חלופיות שניתנו בריצה זו (רשת ביטחון להשלמה) */
  makeupGranted: number;
  missedFound: number;
  needsReview: number;
  errors: number;
}

export type BillingRunResult =
  | { outcome: "ALREADY_RUNNING" }
  | { outcome: "DONE"; runId: string; status: "SUCCEEDED" | "PARTIAL" | "FAILED"; summary: BillingRunSummary };

/** תפיסת הריצה: שורת CronRun בסטטוס RUNNING אחת לכל עבודה (אינדקס ייחודי חלקי). ריצה נטושה (stale) נלקחת */
async function acquireRun(db: PrismaClient, params: { period: string; trigger: string; now: Date }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.cronRun.create({ data: { job: SHIFT_BILLING_JOB, period: params.period, trigger: params.trigger, startedAt: params.now } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const running = await db.cronRun.findFirst({ where: { job: SHIFT_BILLING_JOB, status: "RUNNING" } });
      if (running && params.now.getTime() - running.startedAt.getTime() < CRON_STALE_RUN_MS) return null;
      if (running) {
        await db.cronRun.updateMany({
          where: { id: running.id, status: "RUNNING" },
          data: { status: "FAILED", finishedAt: params.now, summary: { reason: "stale_run_taken_over" } },
        });
      }
    }
  }
  return null;
}

/**
 * הרצת החיוב החודשי (מיועדת ל-Render Cron עתידי, מדי יום; אידמפוטנטית לחלוטין, כך שהרצה חוזרת/כפולה בטוחה):
 *  1) סריקה (scanDueCharges)  2) ביצוע חיובים (chargeShiftMonth, אחד-אחד, שגיאה בפריט לא עוצרת את השאר)
 *  3) ניסיון חוזר אחד ביום לחיובים שנכשלו בתקופת חסד  4) השעיית משמרות שתקופת החסד שלהן חלפה  5) סיום משמרות שהסתיימו.
 * ריצה אחת בכל רגע (CronRun). כל ריצה ותוצאותיה מתועדות.
 */
export async function runMonthlyShiftBilling(params: {
  provider: PaymentProvider;
  trigger: string;
  now?: Date;
  db?: PrismaClient;
  /** נקודת הזרקה לבדיקות בלבד: נקראת אחרי הסריקה ולפני הביצוע */
  hooks?: { afterScan?: () => Promise<void> };
}): Promise<BillingRunResult> {
  const { provider, trigger, now = new Date(), db = defaultDb, hooks } = params;
  const period = currentMonthKey(now);
  const run = await acquireRun(db, { period, trigger, now });
  if (!run) return { outcome: "ALREADY_RUNNING" };

  const summary: BillingRunSummary = { period, scanned: 0, charged: 0, failed: 0, unknown: 0, skipped: 0, retried: 0, retriedPaid: 0, suspended: 0, ended: 0, pendingActivated: 0, pendingReleased: 0, manualOverdue: 0, makeupGranted: 0, missedFound: 0, needsReview: 0, errors: 0 };
  let fatal = false;
  try {
    // 1) סריקה: חיובים שמועדם הגיע (כולל כאלה שהוחמצו בריצה קודמת)
    const { due, needsReview } = await scanDueCharges(db, now);
    summary.scanned = due.length;
    summary.needsReview = needsReview;
    summary.missedFound = due.filter((d) => d.kind === "MISSED").length;
    await hooks?.afterScan?.();

    // 2) ביצוע
    for (const item of due) {
      try {
        const r = await chargeShiftMonth({ shiftId: item.shiftId, month: item.month, provider, now, db });
        if (r.outcome === "PAID") summary.charged++;
        else if (r.outcome === "FAILED") summary.failed++;
        else if (r.outcome === "UNKNOWN") summary.unknown++;
        else summary.skipped++;
      } catch {
        summary.errors++;
      }
    }

    // 2ב) תשלום ידני שלא התקבל במועדו: נכנס למנגנון החובות כמו חיוב רגיל שנכשל (תקופת חסד של 7 ימים ואז השעיה)
    const todayIso = jerusalemTodayIso(now);
    const overdueManual = await db.shiftCharge.findMany({
      where: { status: "PENDING", dueDate: { lt: todayIso }, shift: { status: "ACTIVE", paymentMode: "MANUAL" } },
      include: { shift: { select: { userId: true } } },
    });
    for (const c of overdueManual) {
      try {
        const { count } = await db.shiftCharge.updateMany({
          where: { id: c.id, status: "PENDING" },
          data: { status: "FAILED", failureCode: "manual_payment_overdue", graceUntil: graceDeadline(now), lastAttemptAt: now, claimedAt: null },
        });
        if (count === 1) {
          summary.manualOverdue++;
          await writeAudit(db, { action: "shift_charge.manual_overdue", userId: c.shift.userId, entityType: "ShiftCharge", entityId: c.id, outcome: "ok", reason: `due:${c.dueDate}`, before: { status: "PENDING" }, after: { status: "FAILED", failureCode: "manual_payment_overdue" } });
        }
      } catch {
        summary.errors++;
      }
    }

    // 3) ניסיון חוזר: כישלונות ודאיים בתקופת חסד, פעם אחת ביום (לפי יום ירושלים)
    const todayStart = jerusalemDayStart(jerusalemTodayIso(now));
    const failed = await db.shiftCharge.findMany({
      where: { status: "FAILED", graceUntil: { gt: now }, shift: { status: "ACTIVE", paymentMode: "AUTO" }, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: todayStart } }] },
    });
    for (const charge of failed) {
      try {
        summary.retried++;
        const r = await chargeShiftMonth({ shiftId: charge.shiftId, month: charge.month, provider, retry: true, now, db });
        if (r.outcome === "PAID") summary.retriedPaid++;
        else if (r.outcome === "UNKNOWN") summary.unknown++;
      } catch {
        summary.errors++;
      }
    }

    // 4) השעיה: כישלון ודאי שתקופת החסד שלו חלפה ועדיין לא הוסדר
    const expired = await db.shiftCharge.findMany({ where: { status: "FAILED", graceUntil: { lte: now }, shift: { status: "ACTIVE" } }, select: { shiftId: true, month: true } });
    const suspendShifts = [...new Map(expired.map((e) => [e.shiftId, e])).values()];
    for (const e of suspendShifts) {
      const { count } = await db.shift.updateMany({
        where: { id: e.shiftId, status: "ACTIVE" },
        data: { status: "SUSPENDED", suspendedAt: now, suspensionReason: `payment_failed:${e.month}` },
      });
      summary.suspended += count;
      if (count === 1) await writeAudit(db, { action: "shift.suspended_nonpayment", entityType: "Shift", entityId: e.shiftId, outcome: "ok", reason: `payment_failed:${e.month}` });
    }

    // 4ב) משמרות שממתינות לחיוב ראשון זמן רב מדי: אימות מול הספק, ואם אין אישור ודאי — שחרור המשבצות
    const expired2 = await expireStalePendingShifts(db, provider, now);
    summary.pendingActivated += expired2.activated;
    summary.pendingReleased += expired2.released;

    // 4ג) רשת ביטחון: זיכוי שעות חלופיות שטרם ניתן למפגשים שדולגו במשמרות פעילות
    summary.makeupGranted += (await grantMakeupCredits(db, now)).granted;

    // 5) סיום: משמרת שתקופתה חלפה וכל חודשיה שולמו/אופסו
    const today = jerusalemTodayIso(now);
    const finished = await db.shift.findMany({ where: { status: "ACTIVE", endDate: { lt: today } }, include: { charges: true } });
    for (const shift of finished) {
      const months = billingMonths(shift.startDate);
      const settled = months.every((m) => {
        const c = shift.charges.find((x) => x.month === m);
        return c && (c.status === "PAID" || c.status === "WAIVED");
      });
      if (settled) {
        const { count } = await db.shift.updateMany({ where: { id: shift.id, status: "ACTIVE" }, data: { status: "ENDED" } });
        summary.ended += count;
      }
    }
  } catch {
    fatal = true;
    summary.errors++;
  }

  const status = fatal ? "FAILED" : summary.errors > 0 ? "PARTIAL" : "SUCCEEDED";
  await db.cronRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), summary: summary as never } });
  return { outcome: "DONE", runId: run.id, status, summary };
}

// ───────────────────────────── החזר על מופע ששולם ─────────────────────────────

/**
 * החזר חלקי על חיוב חודשי ששולם (סגירת יום מפורשת / ביטול מאושר). אידמפוטנטי לפי מפתח; לעולם לא מחזיר יותר ממה שנגבה.
 * מחזיר את הסכום שהוחזר בפועל (0 אם אין מה להחזיר או שהספק נכשל; השורה נשארת למעקב ולניסיון חוזר).
 */
export async function refundChargeAmount(params: {
  db?: PrismaClient;
  provider: PaymentProvider;
  chargeId: string;
  amountAgorot: number;
  key: string;
  reason: string;
  createdById?: string;
}): Promise<number> {
  const { db = defaultDb, provider, chargeId, amountAgorot, key, reason, createdById } = params;
  const charge = await db.shiftCharge.findUniqueOrThrow({ where: { id: chargeId }, include: { payment: { include: { refunds: true } } } });
  const payment = charge.payment;
  if (charge.status !== "PAID" || !payment || payment.status !== "SUCCEEDED" || !payment.providerPaymentId) return 0;

  const existing = payment.refunds.find((r) => r.idempotencyKey === key);
  if (existing?.status === "SUCCEEDED") return existing.amountAgorot;
  const refundedSoFar = payment.refunds.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amountAgorot, 0);
  const amount = Math.min(amountAgorot, payment.amountAgorot - refundedSoFar);
  if (amount <= 0) return 0;

  let refund = existing;
  if (!refund) {
    try {
      refund = await db.refund.create({ data: { paymentId: payment.id, amountAgorot: amount, status: "PENDING", reason, idempotencyKey: key, createdById } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      refund = await db.refund.findUniqueOrThrow({ where: { idempotencyKey: key } });
      if (refund.status === "SUCCEEDED") return refund.amountAgorot;
    }
  }
  try {
    const res = await provider.refund({ providerPaymentId: payment.providerPaymentId, amountAgorot: refund.amountAgorot, idempotencyKey: key, reason });
    if (res.status !== "SUCCEEDED") return 0;
    await db.$transaction([
      db.refund.update({ where: { id: refund.id }, data: { status: "SUCCEEDED", providerRefundId: res.providerRefundId } }),
      db.shiftCharge.update({ where: { id: chargeId }, data: { refundedAgorot: { increment: refund.amountAgorot } } }),
    ]);
    return refund.amountAgorot;
  } catch {
    await audit(payment.id, "refund", "error", "shift_refund_failed");
    return 0;
  }
}

// ───────────────────────────── שחרור משבצות של משמרת שלא אושרה ─────────────────────────────

/** משחרר משמרת שלא אושרה: מבטל את הזמנות המפגשים, מסמן את המפגשים והמשמרת כמבוטלים. לא מוחק היסטוריה */
export async function abortPendingShift(db: PrismaClient, shiftId: string, reason: string, now: Date) {
  await db.$transaction(async (tx) => {
    const occurrences = await tx.shiftOccurrence.findMany({ where: { shiftId, status: "SCHEDULED" } });
    const appointmentIds = occurrences.map((o) => o.appointmentId).filter((x): x is string => !!x);
    await tx.appointment.updateMany({ where: { id: { in: appointmentIds }, status: "CONFIRMED" }, data: { status: "CANCELLED" } });
    await tx.shiftOccurrence.updateMany({ where: { shiftId, status: "SCHEDULED" }, data: { status: "CANCELLED", statusNote: reason } });
    await tx.shift.updateMany({ where: { id: shiftId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason } });
    // משמרת שלא אושרה: אין זכאות לשעות חלופיות על ימים שנסגרו לפני האישור (זיכוי ניתן רק למשמרת פעילה)
    await tx.shiftOccurrence.updateMany({ where: { shiftId, makeupStatus: "OWED", makeupCreditId: null }, data: { makeupStatus: null, statusNote: reason } });
  });
}

// ───────────────────────────── שעות חלופיות: זיכוי בדקות ─────────────────────────────

/**
 * נותן זיכוי (Credit, המנגנון הקיים של יתרות דקות) על כל מפגש שדולג בגלל סגירה ביוזמת ההנהלה: בדיוק משך המפגש שבוטל
 * (4 שעות = 240 דקות, 3 שעות = 180). רק למשמרת פעילה (לא למשמרת שעדיין ממתינה לחיוב הראשון), פעם אחת לכל מפגש
 * (אילוץ ייחודיות על makeupCreditId). אידמפוטנטי ובטוח להפעלה חוזרת/מקבילית. אינו נוגע בחיובי המשמרת.
 * הלקוח מממש את הזיכוי כמו כל יתרה: "אישור מהיתרה" בהזמנת חדר, או שיבוץ ע"י מנהל. הזיכוי פוקע אחרי MAKEUP_CREDIT_VALIDITY_DAYS.
 */
export async function grantMakeupCredits(db: PrismaClient, now: Date, filter: { shiftId?: string; date?: string } = {}): Promise<{ granted: number; minutes: number }> {
  const pending = await db.shiftOccurrence.findMany({
    where: {
      status: "SKIPPED_CLOSED_DAY",
      makeupStatus: "OWED",
      makeupCreditId: null,
      shift: { status: "ACTIVE", ...(filter.shiftId ? { id: filter.shiftId } : {}) },
      ...(filter.date ? { date: filter.date } : {}),
    },
    include: { shift: { select: { userId: true } } },
    take: 500,
  });
  let granted = 0;
  let minutes = 0;
  for (const occ of pending) {
    const duration = Math.round((occ.endTime.getTime() - occ.startTime.getTime()) / 60_000);
    if (duration <= 0) continue;
    try {
      await db.$transaction(async (tx) => {
        const credit = await tx.credit.create({
          data: {
            userId: occ.shift.userId,
            minutesTotal: duration,
            minutesRemaining: duration,
            expiresAt: new Date(now.getTime() + MAKEUP_CREDIT_VALIDITY_DAYS * 24 * 3_600_000),
            reason: `shift_makeup:${occ.id}`,
            sourceAppointmentId: occ.appointmentId,
          },
        });
        const { count } = await tx.shiftOccurrence.updateMany({ where: { id: occ.id, makeupStatus: "OWED", makeupCreditId: null }, data: { makeupCreditId: credit.id, makeupUpdatedAt: now } });
        if (count !== 1) throw new Error("makeup already granted");
        await writeAudit(tx, { action: "shift_makeup.granted", userId: occ.shift.userId, entityType: "ShiftOccurrence", entityId: occ.id, outcome: "ok", after: { minutes: duration, creditId: credit.id, date: occ.date } });
      });
      granted++;
      minutes += duration;
    } catch {
      // מתן כפול/מקביל נדחה באילוץ; ממשיכים לשאר המפגשים
    }
  }
  return { granted, minutes };
}

/**
 * משמרת בחיוב אוטומטי שממתינה לאישור החיוב הראשון (מצב לא ידוע / ריצה שנקטעה) לא מחזיקה משבצות ללא הגבלה. אחרי
 * PENDING_SHIFT_MAX_HOLD_MS: אם יש תשלום אצל הספק — מאמתים מולו (הצלחה: המשמרת מאושרת; כישלון ודאי: משוחררת). אם אי אפשר
 * לאמת — המשבצות משוחררות, והחיוב נשאר "לא ידוע" בתור הבירור של המנהל (החזר/הכרעה ידניים; אין חיוב חוזר אוטומטי).
 */
export async function expireStalePendingShifts(db: PrismaClient, provider: PaymentProvider, now: Date): Promise<{ activated: number; released: number }> {
  const cutoff = new Date(now.getTime() - PENDING_SHIFT_MAX_HOLD_MS);
  const stale = await db.shift.findMany({ where: { status: "PENDING", paymentMode: "AUTO", createdAt: { lt: cutoff } }, include: { charges: { where: { isFirst: true } } } });
  let activated = 0;
  let released = 0;
  for (const shift of stale) {
    try {
      const charge = shift.charges[0];
      // ניסיון חיוב שעדיין בתהליך (תפיסה טרייה) לא נקטע
      if (charge?.claimedAt && now.getTime() - charge.claimedAt.getTime() < CHARGE_CLAIM_TTL_MS) continue;
      const payment = charge?.paymentId ? await db.payment.findUnique({ where: { id: charge.paymentId } }) : null;
      if (charge && payment?.providerPaymentId) {
        const res = await settleFromProvider(db, provider, charge, payment.id, payment.providerPaymentId, now);
        if (res.outcome === "PAID") {
          const { count } = await db.shift.updateMany({ where: { id: shift.id, status: "PENDING" }, data: { status: "ACTIVE" } });
          activated += count;
          if (count === 1) await grantMakeupCredits(db, now, { shiftId: shift.id });
          continue;
        }
      }
      await abortPendingShift(db, shift.id, charge?.status === "FAILED" ? "first_charge_failed" : "first_charge_unconfirmed_timeout", now);
      released++;
    } catch {
      // שגיאה במשמרת אחת לא עוצרת את האחרות; תטופל בריצה הבאה
    }
  }
  return { activated, released };
}
