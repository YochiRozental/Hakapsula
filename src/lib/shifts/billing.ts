import type { PrismaClient, ShiftCharge } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { jerusalemDayStart, jerusalemTodayIso } from "@/lib/jerusalem-time";
import type { PaymentProvider } from "@/lib/payments/provider";
import { findUsableCard } from "@/lib/payments/saved-methods";
import { audit, environmentOf, isUniqueViolation } from "@/lib/payments/shared";
import { billingMonths, monthKeyOf } from "@/lib/shifts/calendar";
import { CHARGE_CLAIM_TTL_MS, CRON_STALE_RUN_MS, SHIFT_BILLING_JOB, SHIFT_GRACE_DAYS } from "@/lib/shifts/policy";

/**
 * חיוב חודשי של משמרות. שורה אחת ב-ShiftCharge לכל (משמרת, חודש) -> אי אפשר לחייב פעמיים עבור אותו חודש (אילוץ ייחודיות
 * במסד), ולא נסמכים על תזמון לצורך אידמפוטנטיות. כל ניסיון מקבל מפתח יציב מול הספק (shiftcharge:<shift>:<month>:a<N>) ונרשם
 * ב-Payment. הסכום מחושב בשרת מהמופעים שבפועל מתוזמנים באותו חודש.
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
      if (totals.count === 0) {
        // אין מופעים בחודש הזה: אין מה לחייב. שורה מאופסת מתעדת שהחודש טופל
        const zero = await tx.shiftCharge.create({
          data: { shiftId, month, amountAgorot: 0, occurrenceCount: 0, isFirst, status: "WAIVED", note: "no_occurrences", paidAt: now },
        });
        return { kind: "result", result: { outcome: "NOTHING_DUE", chargeId: zero.id, amountAgorot: 0 } };
      }
      charge = await tx.shiftCharge.create({
        data: { shiftId, month, amountAgorot: totals.amountAgorot, occurrenceCount: totals.count, isFirst, status: "PENDING" },
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
    if (recomputed.count === 0) {
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
        amountAgorot: recomputed.amountAgorot,
        occurrenceCount: recomputed.count,
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
  /** MISSED = חודש קודם שלא חויב (הריצה החודשית הוחמצה) */
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
  const current = currentMonthKey(now);
  const shifts = await db.shift.findMany({ where: { status: "ACTIVE" }, include: { charges: true } });
  const due: DueCharge[] = [];
  let needsReview = 0;
  for (const shift of shifts) {
    for (const month of billingMonths(shift.startDate)) {
      if (month > current) continue;
      const charge = shift.charges.find((c) => c.month === month);
      if (charge?.status === "UNKNOWN") needsReview++;
      if (charge && charge.status !== "PENDING") continue;
      due.push({ shiftId: shift.id, month, kind: month < current ? "MISSED" : "MONTHLY" });
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

  const summary: BillingRunSummary = { period, scanned: 0, charged: 0, failed: 0, unknown: 0, skipped: 0, retried: 0, retriedPaid: 0, suspended: 0, ended: 0, missedFound: 0, needsReview: 0, errors: 0 };
  let fatal = false;
  try {
    // 1) סריקה
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

    // 3) ניסיון חוזר: כישלונות ודאיים בתקופת חסד, פעם אחת ביום (לפי יום ירושלים)
    const todayStart = jerusalemDayStart(jerusalemTodayIso(now));
    const failed = await db.shiftCharge.findMany({
      where: { status: "FAILED", graceUntil: { gt: now }, shift: { status: "ACTIVE" }, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: todayStart } }] },
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
    }

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
