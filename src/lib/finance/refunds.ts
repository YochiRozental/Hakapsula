import { prisma } from "@/lib/prisma";
import type { Prisma, Refund } from "@/generated/prisma/client";
import { IdempotencyConflictError, PaymentStateError, type PaymentProvider } from "@/lib/payments/provider";
import { approveCancellationRefund } from "@/lib/payments/booking-payment";
import { audit as paymentAudit, environmentOf, lockPaymentRow } from "@/lib/payments/shared";
import { writeAudit, writeAuditSafe } from "@/lib/finance/audit";
import { FinanceError, requireAgorot, requireClientKey, requireReason } from "@/lib/finance/errors";

/**
 * ניהול החזרים (שלב H) מעל מודל Refund ושכבת הספק הקיימים.
 *  - לעולם לא מחזירים יותר ממה ששולם בפועל פחות החזרים שאינם כושלים; הבדיקה נעשית תחת נעילת שורת התשלום.
 *  - אין החזר כפול: מפתח אידמפוטנטיות לכל כוונה (ומפתח אחד לכל ספק), ושורת Refund נוצרת לפני הקריאה לספק.
 *  - החזר מסומן מוצלח רק אחרי שהספק אישר. דחייה ודאית של הספק (סכום/מצב לא חוקי) = נכשל. כל שגיאה אחרת = לא ידוע: נשאר
 *    "ממתין" ללא ניסיון חוזר עיוור, ועובר לתור הבירור (אימות מול הספק או הכרעה מתועדת).
 *  - החזר מותר רק על תשלום הזמנה/חוב. רכישת חבילה מוחזרת רק דרך אישור ביטול חבילה, וחיוב משמרת רק דרך שירות המשמרות,
 *    כדי שלא יהיו שני מקורות לאותה רשומה כספית.
 */

type Tx = Prisma.TransactionClient;
const ALLOWED_PURPOSES = ["BOOKING", "DEBT"] as const;

export const refundableAgorot = (payment: { amountAgorot: number; refunds: { amountAgorot: number; status: string }[] }) =>
  Math.max(0, payment.amountAgorot - payment.refunds.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amountAgorot, 0));

export type ExecuteResult = { status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "ALREADY_FINAL"; refundId: string; failureCode?: string };

const DISPATCH = "refund_dispatch";

/** הקריאה לספק עבור שורת Refund ממתינה. אידמפוטנטית מול הספק (אותו מפתח), ומסווגת את התוצאה בזהירות */
export async function executeRefund(params: { refundId: string; provider: PaymentProvider; adminId?: string }): Promise<ExecuteResult> {
  const { refundId, provider, adminId } = params;
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw new FinanceError("ההחזר לא נמצא", "NOT_FOUND");
  if (refund.status !== "PENDING") return { status: "ALREADY_FINAL", refundId };
  const payment = refund.payment;
  if (!payment.providerPaymentId || payment.provider !== provider.name || payment.environment !== environmentOf(provider)) {
    throw new FinanceError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }

  // סימון "נשלח" לפני הקריאה: אם נקטענו באמצע, אי אפשר לדעת אם הספק קיבל, ולכן ההחזר עובר לבירור ולא נשלח שוב אוטומטית
  await prisma.paymentAttempt.create({ data: { paymentId: payment.id, action: DISPATCH, outcome: "ok", detail: refund.id } });

  const fail = async (code: string) => {
    await prisma.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: "FAILED" } });
    await paymentAudit(payment.id, "refund", "error", code);
    await writeAuditSafe({ action: "REFUND_FAILED", adminId, userId: payment.userId, entityType: "Refund", entityId: refund.id, paymentId: payment.id, outcome: "error", reason: code });
    return { status: "FAILED" as const, refundId, failureCode: code };
  };

  let res;
  try {
    res = await provider.refund({ providerPaymentId: payment.providerPaymentId, amountAgorot: refund.amountAgorot, idempotencyKey: refund.idempotencyKey, reason: refund.reason ?? "admin_refund" });
  } catch (err) {
    if (err instanceof PaymentStateError || err instanceof IdempotencyConflictError) return fail("provider_rejected");
    await paymentAudit(payment.id, "refund", "error", "unknown_state");
    await writeAuditSafe({ action: "REFUND_UNKNOWN", adminId, userId: payment.userId, entityType: "Refund", entityId: refund.id, paymentId: payment.id, outcome: "unknown", reason: "provider_unknown" });
    return { status: "UNKNOWN", refundId };
  }
  if (res.status !== "SUCCEEDED") return fail("provider_declined");

  await prisma.$transaction(async (tx) => {
    await lockPaymentRow(tx, payment.id);
    await tx.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: "SUCCEEDED", providerRefundId: res.providerRefundId } });
    await markAppointmentRefunded(tx, payment.id);
  });
  await paymentAudit(payment.id, "refund", "ok");
  await writeAuditSafe({ action: "REFUND_SUCCEEDED", adminId, userId: payment.userId, entityType: "Refund", entityId: refund.id, paymentId: payment.id, outcome: "ok", after: { amountAgorot: refund.amountAgorot } });
  return { status: "SUCCEEDED", refundId };
}

/** כשכל סכום התשלום הוחזר, סטטוס התשלום בהזמנה הופך ל"הוחזר" (כמו בהחזר המלא הקיים) */
async function markAppointmentRefunded(tx: Tx, paymentId: string) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
  if (!payment?.appointmentId) return;
  const done = payment.refunds.filter((r) => r.status === "SUCCEEDED").reduce((n, r) => n + r.amountAgorot, 0);
  if (done >= payment.amountAgorot) await tx.appointment.updateMany({ where: { id: payment.appointmentId }, data: { paymentStatus: "REFUNDED" } });
}

/** יוצר שורת Refund ממתינה תחת נעילת התשלום. משותף להחזר מנהל ולביטול חבילה */
export async function createPendingRefund(tx: Tx, p: { paymentId: string; amountAgorot: number; reason: string; adminId: string; idempotencyKey: string }) {
  await lockPaymentRow(tx, p.paymentId);
  const replay = await tx.refund.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
  if (replay) return { refund: replay, created: false };
  const payment = await tx.payment.findUnique({ where: { id: p.paymentId }, include: { refunds: true } });
  if (!payment) throw new FinanceError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.status !== "SUCCEEDED") throw new FinanceError("ניתן להחזיר רק תשלום שהצליח", "INVALID");
  const cap = refundableAgorot(payment);
  if (p.amountAgorot > cap) throw new FinanceError("סכום ההחזר גדול מהסכום הניתן להחזר", "INVALID", { refundableAgorot: cap });
  const refund = await tx.refund.create({
    data: { paymentId: payment.id, amountAgorot: p.amountAgorot, status: "PENDING", reason: p.reason, idempotencyKey: p.idempotencyKey, createdById: p.adminId },
  });
  return { refund, created: true };
}

export async function issueAdminRefund(input: {
  paymentId: string;
  adminId: string;
  provider: PaymentProvider;
  amountAgorot: unknown;
  reason: unknown;
  clientKey: unknown;
  /** חריג ממדיניות ההחזר האוטומטית (נרשם ביומן) */
  exception?: boolean;
}) {
  const amount = requireAgorot(input.amountAgorot, "סכום ההחזר");
  const reason = requireReason(input.reason);
  const key = requireClientKey(input.clientKey);

  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId }, select: { id: true, userId: true, purpose: true, status: true, provider: true, environment: true, providerPaymentId: true } });
  if (!payment) throw new FinanceError("התשלום לא נמצא", "NOT_FOUND");
  if (!(ALLOWED_PURPOSES as readonly string[]).includes(payment.purpose)) {
    throw new FinanceError("סוג תשלום זה מוחזר רק דרך ביטול החבילה או שירות המשמרות", "INVALID");
  }
  if (payment.status !== "SUCCEEDED" || !payment.providerPaymentId) throw new FinanceError("ניתן להחזיר רק תשלום שהצליח", "INVALID");
  if (payment.provider !== input.provider.name || payment.environment !== environmentOf(input.provider)) {
    throw new FinanceError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }

  const { refund, created } = await prisma.$transaction(async (tx) => {
    const r = await createPendingRefund(tx, { paymentId: payment.id, amountAgorot: amount, reason, adminId: input.adminId, idempotencyKey: `refund-admin:${payment.id}:${key}` });
    if (r.created) {
      await writeAudit(tx, {
        action: input.exception ? "REFUND_EXCEPTION_REQUESTED" : "REFUND_REQUESTED",
        adminId: input.adminId,
        userId: payment.userId,
        entityType: "Refund",
        entityId: r.refund.id,
        paymentId: payment.id,
        outcome: "ok",
        reason,
        after: { amountAgorot: amount, exception: !!input.exception },
      });
    }
    return r;
  });
  const result = created || refund.status === "PENDING" ? await executeRefund({ refundId: refund.id, provider: input.provider, adminId: input.adminId }) : ({ status: "ALREADY_FINAL", refundId: refund.id } as ExecuteResult);
  return { ...result, refundId: refund.id, replayed: !created };
}

// ───────────────────────────── אימות והכרעה בהחזר לא ברור ─────────────────────────────

export type VerifyConclusion = "SUCCEEDED" | "NOT_REFUNDED" | "AMBIGUOUS" | "UNVERIFIABLE";

/**
 * משווה את הסכום שהספק מדווח כמוחזר על התשלום לסכומים שאצלנו. מסיק רק כשהמסקנה חד-משמעית:
 *   מוחזר >= מה שאושר אצלנו + ההחזר הזה  -> בוצע;   מוחזר == מה שאושר אצלנו  -> לא בוצע (ניתן להנפיק החזר חדש).
 * כל מצב אחר (החזרים ממתינים נוספים, סכום ביניים, ספק שאינו מחזיר נתון) -> לא מכריעים: נדרשת הכרעה מתועדת עם אסמכתה.
 * הנחה: הספק מדווח refundedAgorot נכון. ספק אמיתי (PAYME) חייב לאמת יכולת זו לפני הפעלה.
 */
export async function verifyRefund(params: { refundId: string; adminId: string; provider: PaymentProvider }) {
  const { refundId, adminId, provider } = params;
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: { include: { refunds: true } } } });
  if (!refund) throw new FinanceError("ההחזר לא נמצא", "NOT_FOUND");
  if (refund.status !== "PENDING") throw new FinanceError("ההחזר כבר הוכרע", "CONFLICT");
  const payment = refund.payment;
  const others = payment.refunds.filter((r) => r.id !== refund.id);
  const pendingOthers = others.filter((r) => r.status === "PENDING").length;
  const succeededOthers = others.filter((r) => r.status === "SUCCEEDED").reduce((n, r) => n + r.amountAgorot, 0);

  let conclusion: VerifyConclusion = "UNVERIFIABLE";
  let providerRefunded: number | undefined;
  if (payment.providerPaymentId && payment.provider === provider.name) {
    try {
      providerRefunded = (await provider.getPaymentStatus(payment.providerPaymentId)).refundedAgorot;
    } catch {
      providerRefunded = undefined;
    }
  }
  if (providerRefunded !== undefined) {
    if (pendingOthers > 0) conclusion = "AMBIGUOUS";
    else if (providerRefunded >= succeededOthers + refund.amountAgorot) conclusion = "SUCCEEDED";
    else if (providerRefunded === succeededOthers) conclusion = "NOT_REFUNDED";
    else conclusion = "AMBIGUOUS";
  }

  if (conclusion === "SUCCEEDED" || conclusion === "NOT_REFUNDED") {
    await prisma.$transaction(async (tx) => {
      await lockPaymentRow(tx, payment.id);
      const { count } = await tx.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: conclusion === "SUCCEEDED" ? "SUCCEEDED" : "FAILED" } });
      if (count === 1 && conclusion === "SUCCEEDED") await markAppointmentRefunded(tx, payment.id);
      await writeAudit(tx, {
        action: "REFUND_VERIFIED",
        adminId,
        userId: payment.userId,
        entityType: "Refund",
        entityId: refund.id,
        paymentId: payment.id,
        outcome: "ok",
        reason: conclusion === "SUCCEEDED" ? "verified_with_provider_refunded" : "verified_with_provider_not_refunded",
        after: { providerRefundedAgorot: providerRefunded ?? null, amountAgorot: refund.amountAgorot },
      });
    });
  } else {
    await writeAuditSafe({ action: "REFUND_VERIFY_INCONCLUSIVE", adminId, userId: payment.userId, entityType: "Refund", entityId: refund.id, paymentId: payment.id, outcome: "unknown", reason: conclusion.toLowerCase() });
  }
  return { refundId, conclusion, providerRefundedAgorot: providerRefunded ?? null };
}

/**
 * הכרעה ידנית בהחזר שאי אפשר לאמת מול הספק. נדרשת אסמכתה (למשל אישור מהספק), והפעולה נרשמת כ"לא מאומתת".
 * אם הספק כן יודע לענות, ההכרעה נדחית: משתמשים באימות.
 */
export async function resolveRefundManually(input: { refundId: string; adminId: string; provider: PaymentProvider; outcome: unknown; evidence: unknown; note?: unknown }) {
  if (input.outcome !== "SUCCEEDED" && input.outcome !== "FAILED") throw new FinanceError("תוצאה לא תקינה", "INVALID");
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
  if (evidence.length < 6) throw new FinanceError("נדרשת אסמכתה להכרעה ידנית (למשל אישור מהספק)", "INVALID");
  const probe = await verifyRefund({ refundId: input.refundId, adminId: input.adminId, provider: input.provider });
  if (probe.conclusion === "SUCCEEDED" || probe.conclusion === "NOT_REFUNDED") {
    const matches = (probe.conclusion === "SUCCEEDED") === (input.outcome === "SUCCEEDED");
    if (!matches) throw new FinanceError("התוצאה שדווחה אינה תואמת למה שהספק מדווח", "CONFLICT");
    return { refundId: input.refundId, resolvedBy: "provider_verification" as const };
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: input.refundId }, include: { payment: true } });
    if (!refund) throw new FinanceError("ההחזר לא נמצא", "NOT_FOUND");
    await lockPaymentRow(tx, refund.paymentId);
    const { count } = await tx.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: input.outcome as "SUCCEEDED" | "FAILED" } });
    if (count !== 1) throw new FinanceError("ההחזר כבר הוכרע", "CONFLICT");
    if (input.outcome === "SUCCEEDED") await markAppointmentRefunded(tx, refund.paymentId);
    await writeAudit(tx, {
      action: "REFUND_RESOLVED_MANUAL",
      adminId: input.adminId,
      userId: refund.payment.userId,
      entityType: "Refund",
      entityId: refund.id,
      paymentId: refund.paymentId,
      outcome: "ok",
      reason: `${evidence.slice(0, 120)}${note ? ` | ${note}` : ""}`,
      after: { outcome: input.outcome, verification: "unverified_manual" },
    });
  });
  return { refundId: input.refundId, resolvedBy: "manual_unverified" as const };
}

/** שולח החזר ממתין שמעולם לא נשלח לספק (נוצר אך הקריאה לא התבצעה). החזר ששודר פעם עובר רק אימות */
export async function sendUnsentRefund(params: { refundId: string; adminId: string; provider: PaymentProvider }) {
  const refund = await prisma.refund.findUnique({ where: { id: params.refundId } });
  if (!refund) throw new FinanceError("ההחזר לא נמצא", "NOT_FOUND");
  if (refund.status !== "PENDING") throw new FinanceError("ההחזר כבר הוכרע", "CONFLICT");
  const dispatched = await prisma.paymentAttempt.count({ where: { paymentId: refund.paymentId, action: DISPATCH, detail: refund.id } });
  if (dispatched > 0) throw new FinanceError("ההחזר כבר נשלח לספק ומצבו לא ידוע. יש לאמת מול הספק", "CONFLICT");
  return executeRefund({ refundId: refund.id, provider: params.provider, adminId: params.adminId });
}

// ───────────────────────────── תצוגה ─────────────────────────────

export type RefundState = "SUCCEEDED" | "FAILED" | "PENDING_NOT_SENT" | "PENDING_UNKNOWN";

export interface RefundFilters {
  userId?: string;
  status?: string;
  from?: Date;
  to?: Date;
}

export async function listRefunds(f: RefundFilters = {}) {
  const rows = await prisma.refund.findMany({
    where: {
      ...(f.status ? { status: f.status as never } : {}),
      ...(f.userId ? { payment: { userId: f.userId } } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
    },
    include: { payment: { include: { user: { select: { id: true, name: true } }, refunds: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const dispatched = await prisma.paymentAttempt.findMany({ where: { action: DISPATCH, detail: { in: rows.map((r) => r.id) } }, select: { detail: true } });
  const sent = new Set(dispatched.map((d) => d.detail));
  return rows.map((r) => toRefundView(r, sent.has(r.id)));
}

type RefundRow = Refund & { payment: { id: string; userId: string; purpose: string; amountAgorot: number; provider: string; appointmentId: string | null; user: { id: string; name: string }; refunds: { amountAgorot: number; status: string }[] } };

function toRefundView(r: RefundRow, dispatched: boolean) {
  const state: RefundState = r.status === "SUCCEEDED" ? "SUCCEEDED" : r.status === "FAILED" ? "FAILED" : dispatched ? "PENDING_UNKNOWN" : "PENDING_NOT_SENT";
  return {
    id: r.id,
    state,
    status: r.status,
    amountAgorot: r.amountAgorot,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    createdByAdmin: !!r.createdById,
    user: r.payment.user,
    payment: { id: r.payment.id, purpose: r.payment.purpose, amountAgorot: r.payment.amountAgorot, provider: r.payment.provider, appointmentId: r.payment.appointmentId },
    refundableLeftAgorot: refundableAgorot(r.payment),
  };
}

// ───────────────────────────── חריגי החזר על ביטול מאוחר ─────────────────────────────

/** הזמנות שבוטלו ללא החזר (ביטול מאוחר) ושעדיין יש בהן תשלום בכסף, או דקות שנוצלו, וטרם הוכרע בהן חריג */
export async function listRefundExceptions() {
  const rows = await prisma.appointment.findMany({
    where: {
      status: "CANCELLED",
      source: { not: "SHIFT" },
      OR: [{ payments: { some: { purpose: "BOOKING", status: "SUCCEEDED" } } }, { paidFromBalanceMinutes: { gt: 0 } }],
    },
    include: { user: { select: { id: true, name: true } }, room: { select: { name: true } }, payments: { where: { purpose: "BOOKING", status: "SUCCEEDED" }, include: { refunds: true } }, debt: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
  const reviewed = new Set((await prisma.refundReview.findMany({ where: { appointmentId: { in: rows.map((r) => r.id) } }, select: { appointmentId: true } })).map((r) => r.appointmentId));
  const usage = await prisma.packageUsage.findMany({ where: { appointmentId: { in: rows.map((r) => r.id) } } });
  const creditUsage = await prisma.creditUsage.findMany({ where: { appointmentId: { in: rows.map((r) => r.id) } } });
  const netMinutes = (id: string) =>
    [...usage, ...creditUsage].filter((u) => u.appointmentId === id).reduce((n, u) => n + (u.kind === "CONSUME" ? u.minutes : -u.minutes), 0);

  const out = [];
  for (const a of rows) {
    if (reviewed.has(a.id)) continue;
    const refundable = a.payments.reduce((n, p) => n + refundableAgorot(p), 0);
    const minutes = netMinutes(a.id);
    const openDebt = a.debt && (a.debt.status === "OPEN" || a.debt.status === "IN_REVIEW");
    if (refundable <= 0 && minutes <= 0 && !openDebt) continue;
    out.push({
      appointmentId: a.id,
      user: a.user,
      roomName: a.room.name,
      startTime: a.startTime.toISOString(),
      refundableAgorot: refundable,
      unrestoredMinutes: Math.max(0, minutes),
      hasOpenDebt: !!openDebt,
    });
  }
  return out;
}

/** אישור (החזר כסף + דקות + ויתור אופציונלי על חוב, דרך השירות הקיים) או דחייה של חריג החזר. אידמפוטנטי */
export async function decideRefundException(input: { appointmentId: string; adminId: string; provider: PaymentProvider; decision: unknown; reason: unknown; waiveDebt?: boolean }) {
  const reason = requireReason(input.reason);
  if (input.decision !== "APPROVE" && input.decision !== "REJECT") throw new FinanceError("החלטה לא תקינה", "INVALID");
  const appt = await prisma.appointment.findUnique({ where: { id: input.appointmentId }, select: { id: true, userId: true, status: true } });
  if (!appt || appt.status !== "CANCELLED") throw new FinanceError("ההזמנה המבוטלת לא נמצאה", "NOT_FOUND");
  const existing = await prisma.refundReview.findUnique({ where: { appointmentId: appt.id } });
  if (existing) throw new FinanceError("כבר התקבלה החלטה בבקשה זו", "CONFLICT");

  if (input.decision === "REJECT") {
    await prisma.$transaction(async (tx) => {
      await tx.refundReview.create({ data: { appointmentId: appt.id, status: "REJECTED", reason, decidedById: input.adminId } });
      await writeAudit(tx, { action: "REFUND_EXCEPTION_REJECTED", adminId: input.adminId, userId: appt.userId, entityType: "Appointment", entityId: appt.id, outcome: "ok", reason });
    });
    return { decision: "REJECT" as const };
  }

  try {
    await prisma.refundReview.create({ data: { appointmentId: appt.id, status: "APPROVED", reason, decidedById: input.adminId } });
  } catch {
    throw new FinanceError("כבר התקבלה החלטה בבקשה זו", "CONFLICT");
  }
  try {
    const res = await approveCancellationRefund({ appointmentId: appt.id, adminId: input.adminId, provider: input.provider, waiveDebt: input.waiveDebt === true });
    await writeAuditSafe({
      action: "REFUND_EXCEPTION_APPROVED",
      adminId: input.adminId,
      userId: appt.userId,
      entityType: "Appointment",
      entityId: appt.id,
      paymentId: res.refund?.paymentId ?? null,
      outcome: "ok",
      reason,
      after: { refundStatus: res.refund?.status ?? "NOTHING_TO_REFUND", minutesRestored: res.minutesRestored, creditedMinutes: res.creditedMinutes, debtWaived: res.debtWaived },
    });
    return { decision: "APPROVE" as const, refundStatus: res.refund?.status ?? "NOTHING_TO_REFUND", minutesRestored: res.minutesRestored, creditedMinutes: res.creditedMinutes, debtWaived: res.debtWaived };
  } catch (err) {
    // ההחלטה נשמרה; הדקות/החוב טופלו (אם הצליחו) וההחזר הכספי ממתין בתור ההחזרים. לא מנסים שוב באופן עיוור
    await writeAuditSafe({ action: "REFUND_EXCEPTION_APPROVED", adminId: input.adminId, userId: appt.userId, entityType: "Appointment", entityId: appt.id, outcome: "unknown", reason });
    throw new FinanceError("האישור נרשם, אך ההחזר מול הספק לא הושלם ונמצא בבירור", "PROVIDER_UNKNOWN", { cause: err instanceof Error ? err.name : "unknown" });
  }
}
