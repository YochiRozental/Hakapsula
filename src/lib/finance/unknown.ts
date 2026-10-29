import { prisma } from "@/lib/prisma";
import type { PaymentProvider } from "@/lib/payments/provider";
import { finalizePayment } from "@/lib/payments/booking-payment";
import { lockPaymentRow } from "@/lib/payments/shared";
import { resolveUnknownCharge } from "@/lib/shifts/lifecycle";
import { writeAudit, writeAuditSafe } from "@/lib/finance/audit";
import { FinanceError, requireReason } from "@/lib/finance/errors";

/**
 * תור הבירור: פעולות כספיות שמצבן אינו ידוע (תשלום שנתקע בהמתנה, החזר ששודר ללא תשובה, חיוב משמרת במצב לא ידוע).
 *
 * עקרונות:
 *  - אימות מול הספק קודם לכל הכרעה. אם הספק יודע לענות, תשובתו קובעת והכרעת מנהל שאינה תואמת נדחית.
 *  - הכרעה ידנית ("לא חויב"/"כשל") מותרת רק כשאי אפשר לאמת, ורק עם אסמכתה. היא לעולם אינה מסמנת הצלחה לבדה, כי הצלחה
 *    מחייבת את תופעות הלוואי של אישור ההזמנה/החבילה (שמבצע finalizePayment מול נתוני הספק).
 *  - אין ניסיון חיוב חוזר עיוור: חיוב חדש נפתח רק אחרי שהחיוב הקודם הוכרע כנכשל, ובמפתח אידמפוטנטיות חדש.
 *  - מבנה ההתאמה ל-PAYME עתידי: כל הבדיקות עוברות דרך חוזה PaymentProvider (getPaymentStatus.refundedAgorot / status).
 *    אין להניח שיכולת התאמה לפי מפתח אידמפוטנטיות קיימת אצל ספק אמיתי בלי לאמת אותה בתיעוד שלו.
 */

/** תשלום ממתין ותיק מזה נחשב "תקוע": החזקת ההזמנה פגה מזמן ולקוח שסיים תשלום כבר היה מסיים אותו */
export const STUCK_PAYMENT_MS = 30 * 60_000;

export type InquiryStatus = "AWAITING" | "NOTED" | "VERIFIED_INCONCLUSIVE";

async function inquiryStatuses(entityType: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, { status: InquiryStatus; notes: number; lastNote: string | null }>();
  const rows = await prisma.auditLog.findMany({
    where: { entityType, entityId: { in: ids }, action: { in: ["INQUIRY_NOTE", "REFUND_VERIFY_INCONCLUSIVE", "PAYMENT_VERIFY_INCONCLUSIVE"] } },
    orderBy: { createdAt: "desc" },
  });
  const out = new Map<string, { status: InquiryStatus; notes: number; lastNote: string | null }>();
  for (const r of rows) {
    const cur = out.get(r.entityId!) ?? { status: "AWAITING" as InquiryStatus, notes: 0, lastNote: null };
    if (r.action === "INQUIRY_NOTE") {
      cur.notes += 1;
      cur.lastNote ??= r.reason;
      if (cur.status === "AWAITING") cur.status = "NOTED";
    } else if (cur.status === "AWAITING") cur.status = "VERIFIED_INCONCLUSIVE";
    out.set(r.entityId!, cur);
  }
  return out;
}

export async function listUnknown(now: Date = new Date(), includeShifts = true) {
  const stuckBefore = new Date(now.getTime() - STUCK_PAYMENT_MS);
  const [payments, refunds, charges] = await Promise.all([
    prisma.payment.findMany({
      where: { status: "PENDING", purpose: { in: ["BOOKING", "PACKAGE", "DEBT"] }, createdAt: { lte: stuckBefore } },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.refund.findMany({
      where: { status: "PENDING" },
      include: { payment: { include: { user: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    includeShifts
      ? prisma.shiftCharge.findMany({ where: { status: "UNKNOWN" }, include: { shift: { include: { user: { select: { id: true, name: true } }, room: { select: { name: true } } } } }, orderBy: { lastAttemptAt: "asc" }, take: 100 })
      : Promise.resolve([]),
  ]);
  const dispatched = await prisma.paymentAttempt.findMany({ where: { action: "refund_dispatch", detail: { in: refunds.map((r) => r.id) } }, select: { detail: true } });
  const sent = new Set(dispatched.map((d) => d.detail));
  const [pInq, rInq, cInq] = await Promise.all([
    inquiryStatuses("Payment", payments.map((p) => p.id)),
    inquiryStatuses("Refund", refunds.map((r) => r.id)),
    inquiryStatuses("ShiftCharge", charges.map((c) => c.id)),
  ]);
  const inq = (m: Map<string, { status: InquiryStatus; notes: number; lastNote: string | null }>, id: string) => m.get(id) ?? { status: "AWAITING" as InquiryStatus, notes: 0, lastNote: null };

  return {
    payments: payments.map((p) => ({
      kind: "PAYMENT" as const,
      id: p.id,
      user: p.user,
      amountAgorot: p.amountAgorot,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      idempotencyKey: p.idempotencyKey,
      createdAt: p.createdAt.toISOString(),
      original: `${p.purpose}${p.appointmentId ? ` · הזמנה ${p.appointmentId}` : ""}${p.packageHours ? ` · חבילת ${p.packageHours} שעות` : ""}`,
      verifiable: !!p.providerPaymentId,
      inquiry: inq(pInq, p.id),
    })),
    refunds: refunds.map((r) => ({
      kind: "REFUND" as const,
      id: r.id,
      user: r.payment.user,
      amountAgorot: r.amountAgorot,
      provider: r.payment.provider,
      providerPaymentId: r.payment.providerPaymentId,
      idempotencyKey: r.idempotencyKey,
      createdAt: r.createdAt.toISOString(),
      original: `החזר על תשלום ${r.payment.id}${r.reason ? ` · ${r.reason}` : ""}`,
      sentToProvider: sent.has(r.id),
      inquiry: inq(rInq, r.id),
    })),
    shiftCharges: charges.map((c) => ({
      kind: "SHIFT_CHARGE" as const,
      id: c.id,
      shiftId: c.shiftId,
      user: c.shift.user,
      amountAgorot: c.amountAgorot,
      month: c.month,
      createdAt: (c.lastAttemptAt ?? c.shift.createdAt).toISOString(),
      original: `חיוב משמרת ${c.month} · ${c.shift.room.name}`,
      paymentId: c.paymentId,
      inquiry: inq(cInq, c.id),
    })),
  };
}

export async function recordInquiryNote(input: { entityType: "Payment" | "Refund" | "ShiftCharge"; entityId: string; adminId: string; note: unknown }) {
  const note = requireReason(input.note, 3, 500);
  const exists =
    input.entityType === "Payment"
      ? await prisma.payment.findUnique({ where: { id: input.entityId }, select: { userId: true } })
      : input.entityType === "Refund"
        ? await prisma.refund.findUnique({ where: { id: input.entityId }, select: { id: true } }).then((r) => (r ? { userId: undefined } : null))
        : await prisma.shiftCharge.findUnique({ where: { id: input.entityId }, select: { id: true } }).then((r) => (r ? { userId: undefined } : null));
  if (!exists) throw new FinanceError("הפעולה לא נמצאה", "NOT_FOUND");
  await writeAudit(prisma, { action: "INQUIRY_NOTE", adminId: input.adminId, userId: exists.userId ?? null, entityType: input.entityType, entityId: input.entityId, outcome: "ok", reason: note });
  return { ok: true };
}

/**
 * אימות תשלום תקוע מול הספק. תשובה חד-משמעית (הצלחה/כישלון/ביטול) מסיימת אותו דרך finalizePayment הקיים עם כל תופעות הלוואי
 * התקינות. תשובה ממתינה או שגיאה משאירה אותו בבירור.
 */
export async function verifyPayment(params: { paymentId: string; adminId: string; provider: PaymentProvider; now?: Date }) {
  const { paymentId, adminId, provider, now = new Date() } = params;
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new FinanceError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.status !== "PENDING") throw new FinanceError("התשלום כבר הוכרע", "CONFLICT");
  if (!payment.providerPaymentId) {
    await writeAuditSafe({ action: "PAYMENT_VERIFY_INCONCLUSIVE", adminId, userId: payment.userId, entityType: "Payment", entityId: payment.id, paymentId: payment.id, outcome: "unknown", reason: "no_provider_payment_id" });
    return { conclusion: "UNVERIFIABLE" as const };
  }
  let status;
  try {
    status = await provider.getPaymentStatus(payment.providerPaymentId);
  } catch {
    await writeAuditSafe({ action: "PAYMENT_VERIFY_INCONCLUSIVE", adminId, userId: payment.userId, entityType: "Payment", entityId: payment.id, paymentId: payment.id, outcome: "unknown", reason: "provider_unreachable" });
    return { conclusion: "UNVERIFIABLE" as const };
  }
  if (status.status === "PENDING") {
    await writeAuditSafe({ action: "PAYMENT_VERIFY_INCONCLUSIVE", adminId, userId: payment.userId, entityType: "Payment", entityId: payment.id, paymentId: payment.id, outcome: "unknown", reason: "still_pending_at_provider" });
    return { conclusion: "STILL_PENDING" as const };
  }
  let finalized: string;
  if (payment.purpose === "BOOKING" || payment.purpose === "PACKAGE") {
    const res = await finalizePayment({ paymentId, provider, now });
    finalized = res.outcome;
  } else {
    throw new FinanceError("סוג תשלום זה אינו נתמך באימות אוטומטי", "INVALID");
  }
  await writeAuditSafe({ action: "PAYMENT_VERIFIED", adminId, userId: payment.userId, entityType: "Payment", entityId: payment.id, paymentId: payment.id, outcome: "ok", reason: `provider:${status.status}`, after: { finalized } });
  return { conclusion: status.status, finalized };
}

/**
 * הכרעה ידנית בתשלום שלא ניתן לאמת: רק "כשל" או "בוטל", רק עם אסמכתה, ורק אם הספק אינו יכול לענות. הצלחה לעולם לא מוכרזת ידנית.
 * אם לספק יש תשובה, מבצעים אימות רגיל במקום.
 */
export async function resolvePaymentManually(input: { paymentId: string; adminId: string; provider: PaymentProvider; outcome: unknown; evidence: unknown; note?: unknown }) {
  if (input.outcome !== "FAILED" && input.outcome !== "CANCELLED") throw new FinanceError("ניתן להכריע ידנית רק כשל או ביטול. הצלחה נקבעת אך ורק לפי הספק", "INVALID");
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
  if (evidence.length < 6) throw new FinanceError("נדרשת אסמכתה להכרעה ידנית", "INVALID");
  const probe = await verifyPayment({ paymentId: input.paymentId, adminId: input.adminId, provider: input.provider });
  if (probe.conclusion !== "UNVERIFIABLE") {
    if (probe.conclusion === "STILL_PENDING") throw new FinanceError("התשלום עדיין ממתין אצל הספק; אין להכריע", "CONFLICT");
    return { resolvedBy: "provider_verification" as const, conclusion: probe.conclusion };
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  await prisma.$transaction(async (tx) => {
    await lockPaymentRow(tx, input.paymentId);
    const p = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!p) throw new FinanceError("התשלום לא נמצא", "NOT_FOUND");
    const { count } = await tx.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: input.outcome as "FAILED" | "CANCELLED", failureCode: "manual_resolution" } });
    if (count !== 1) throw new FinanceError("התשלום כבר הוכרע", "CONFLICT");
    await writeAudit(tx, {
      action: "PAYMENT_RESOLVED_MANUAL",
      adminId: input.adminId,
      userId: p.userId,
      entityType: "Payment",
      entityId: p.id,
      paymentId: p.id,
      outcome: "ok",
      reason: `${evidence.slice(0, 120)}${note ? ` | ${note}` : ""}`,
      after: { outcome: input.outcome, verification: "unverified_manual" },
    });
  });
  return { resolvedBy: "manual_unverified" as const, conclusion: input.outcome as string };
}

/**
 * הכרעה בחיוב משמרת לא ידוע, מעל resolveUnknownCharge של שלב G, עם אותה הקפדה: אם הספק יכול לאמת, תשובתו קובעת. "לא חויב"
 * פותח אפשרות לחיוב חוזר, ולכן הוא מותר רק עם אימות או אסמכתה.
 */
export async function resolveShiftChargeUnknown(input: { chargeId: string; adminId: string; provider: PaymentProvider; outcome: unknown; evidence?: unknown; note?: unknown }) {
  if (input.outcome !== "PAID" && input.outcome !== "NOT_CHARGED") throw new FinanceError("תוצאה לא תקינה", "INVALID");
  const charge = await prisma.shiftCharge.findUnique({ where: { id: input.chargeId }, include: { payment: true, shift: { select: { userId: true } } } });
  if (!charge) throw new FinanceError("החיוב לא נמצא", "NOT_FOUND");
  if (charge.status !== "UNKNOWN") throw new FinanceError("החיוב אינו במצב לא ידוע", "CONFLICT");

  let verified: "SUCCEEDED" | "FAILED" | "CANCELLED" | null = null;
  if (charge.payment?.providerPaymentId) {
    try {
      const s = await input.provider.getPaymentStatus(charge.payment.providerPaymentId);
      if (s.status !== "PENDING") verified = s.status;
    } catch {
      verified = null;
    }
  }
  if (verified) {
    const providerSaysPaid = verified === "SUCCEEDED";
    if (providerSaysPaid !== (input.outcome === "PAID")) throw new FinanceError("התוצאה שדווחה אינה תואמת למה שהספק מדווח", "CONFLICT", { provider: verified });
  } else {
    const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
    if (evidence.length < 6) throw new FinanceError("אי אפשר לאמת מול הספק. נדרשת אסמכתה להכרעה", "INVALID");
  }
  const text = [typeof input.evidence === "string" ? input.evidence.trim().slice(0, 120) : "", typeof input.note === "string" ? input.note.trim().slice(0, 200) : ""].filter(Boolean).join(" | ");
  const res = await resolveUnknownCharge({ chargeId: input.chargeId, adminId: input.adminId, outcome: input.outcome, note: `${verified ? "verified" : "unverified_manual"}: ${text}` });
  await writeAuditSafe({
    action: "SHIFT_CHARGE_UNKNOWN_RESOLVED",
    adminId: input.adminId,
    userId: charge.shift.userId,
    entityType: "ShiftCharge",
    entityId: charge.id,
    paymentId: charge.paymentId,
    outcome: "ok",
    reason: text || null,
    after: { outcome: input.outcome, verification: verified ? "provider" : "unverified_manual" },
  });
  return res;
}
