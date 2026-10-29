import { prisma } from "@/lib/prisma";
import type { PaymentProvider } from "@/lib/payments/provider";
import { lockPaymentRow, lockUserBalances } from "@/lib/payments/shared";
import { writeAudit } from "@/lib/finance/audit";
import { FinanceError, requireAgorot, requireReason } from "@/lib/finance/errors";
import { createPendingRefund, executeRefund, refundableAgorot } from "@/lib/finance/refunds";

/**
 * בקשות ביטול חבילה (שלב H), מעל PackageCancellationRequest משלב E.
 *
 * החלטות עסקיות שאושרו: החבילה נשארת פעילה כל עוד הבקשה ממתינה (הלקוח רשאי לנצל שעות); אין החזר אוטומטי מבקשת לקוח.
 * לא נקבעה נוסחה להחזר כספי בביטול חבילה שנוצלה חלקית, ולכן לא ממציאים אחת: המערכת מציגה מידע (מחיר, ניצול, יתרה,
 * ערך יחסי כמידע בלבד) והמנהל קובע סכום החזר מפורש, בכפוף לתקרה: מה ששולם בפועל פחות החזרים קודמים.
 *
 * אישור ביטול = טרנזקציה אחת: נעילת הבקשה, התשלום והיתרות של הלקוח (באותו סדר נעילות של שאר הזרימות, ולכן אישור הזמנה מקביל
 * מהיתרה מסתדר בטור: או שהוא קודם ומנכה את דקותיו, או שהוא מגיע אחרי האיפוס ונכשל כחוסר יתרה), קריאה מחדש של המצב המעודכן,
 * איפוס היתרה ורישום ההחלטה. החזר כספי (אם נקבע) נוצר כשורה ממתינה באותה טרנזקציה ומבוצע אחריה דרך שכבת ההחזרים הקיימת,
 * כך שתקלת ספק משאירה החזר ממתין שניתן לטפל בו (אימות/שליחה) ולא מבטלת את ההחלטה.
 */

export async function listCancellationRequests(status: "PENDING" | "ALL" = "PENDING", now: Date = new Date()) {
  const rows = await prisma.packageCancellationRequest.findMany({
    where: status === "PENDING" ? { status: "PENDING" } : {},
    include: {
      user: { select: { id: true, name: true, email: true, phone: true } },
      package: { include: { payment: { include: { refunds: true } }, usages: true } },
    },
    orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
    take: 200,
  });
  return rows.map((r) => {
    const p = r.package;
    const consumed = p.minutesTotal - p.minutesRemaining;
    const refunds = p.payment?.refunds ?? [];
    const refundedSoFar = refunds.filter((x) => x.status === "SUCCEEDED").reduce((n, x) => n + x.amountAgorot, 0);
    const refundPending = refunds.filter((x) => x.status === "PENDING").reduce((n, x) => n + x.amountAgorot, 0);
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      refundAgorot: r.refundAgorot,
      forfeitedMinutes: r.forfeitedMinutes,
      user: r.user,
      package: {
        id: p.id,
        hours: p.hours,
        pricePaidAgorot: p.pricePaidAgorot,
        minutesTotal: p.minutesTotal,
        minutesConsumed: consumed,
        minutesRemaining: p.minutesRemaining,
        purchasedAt: p.purchasedAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        expired: p.expiresAt.getTime() <= now.getTime(),
        cancelledAt: p.cancelledAt?.toISOString() ?? null,
        paymentId: p.paymentId,
        refundedAgorot: refundedSoFar,
        refundPendingAgorot: refundPending,
        refundableAgorot: p.payment ? refundableAgorot(p.payment) : 0,
        /** מידע בלבד, לא נוסחת החזר: הערך היחסי של הדקות שנותרו לפי מחיר הרכישה */
        proportionalValueOfRemainingAgorot: p.minutesTotal > 0 ? Math.floor((p.pricePaidAgorot * p.minutesRemaining) / p.minutesTotal) : 0,
      },
    };
  });
}

export async function decideCancellationRequest(input: {
  requestId: string;
  adminId: string;
  provider: PaymentProvider;
  decision: unknown;
  reason: unknown;
  refundAgorot?: unknown;
  now?: Date;
}) {
  const reason = requireReason(input.reason);
  const { now = new Date() } = input;
  if (input.decision !== "APPROVE" && input.decision !== "REJECT") throw new FinanceError("החלטה לא תקינה", "INVALID");

  if (input.decision === "REJECT") {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PackageCancellationRequest" WHERE id = ${input.requestId} FOR UPDATE`;
      const req = await tx.packageCancellationRequest.findUnique({ where: { id: input.requestId } });
      if (!req) throw new FinanceError("הבקשה לא נמצאה", "NOT_FOUND");
      if (req.status !== "PENDING") throw new FinanceError("הבקשה כבר הוכרעה", "CONFLICT");
      await tx.packageCancellationRequest.update({ where: { id: req.id }, data: { status: "REJECTED", decidedAt: now, decidedById: input.adminId, decisionNote: reason } });
      await writeAudit(tx, { action: "PACKAGE_CANCEL_REJECTED", adminId: input.adminId, userId: req.userId, entityType: "PackageCancellationRequest", entityId: req.id, outcome: "ok", reason, after: { packageId: req.packageId } });
      return { decision: "REJECT" as const, refundId: null as string | null, refundStatus: null as string | null, forfeitedMinutes: null as number | null };
    });
  }

  const refundAgorot = input.refundAgorot === undefined || input.refundAgorot === 0 ? 0 : requireAgorot(input.refundAgorot, "סכום ההחזר");

  const approved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PackageCancellationRequest" WHERE id = ${input.requestId} FOR UPDATE`;
    const req = await tx.packageCancellationRequest.findUnique({ where: { id: input.requestId }, include: { package: true } });
    if (!req) throw new FinanceError("הבקשה לא נמצאה", "NOT_FOUND");
    if (req.status !== "PENDING") throw new FinanceError("הבקשה כבר הוכרעה", "CONFLICT");

    // סדר הנעילות כבשאר הזרימות: תשלום, ואחר כך יתרות הלקוח
    if (req.package.paymentId) await lockPaymentRow(tx, req.package.paymentId);
    await lockUserBalances(tx, req.userId);
    const pkg = await tx.hoursPackage.findUniqueOrThrow({ where: { id: req.packageId } });
    if (pkg.cancelledAt) throw new FinanceError("החבילה כבר בוטלה", "CONFLICT");

    let refundId: string | null = null;
    if (refundAgorot > 0) {
      if (!pkg.paymentId) throw new FinanceError("אין תשלום מקושר לחבילה להחזר", "INVALID");
      const payment = await tx.payment.findUnique({ where: { id: pkg.paymentId }, include: { refunds: true } });
      if (!payment || payment.status !== "SUCCEEDED") throw new FinanceError("התשלום על החבילה לא הצליח; אין מה להחזיר", "INVALID");
      if (payment.provider !== input.provider.name) throw new FinanceError("התשלום אינו שייך לספק הנוכחי", "INVALID");
      const cap = refundableAgorot(payment);
      if (refundAgorot > cap) throw new FinanceError("סכום ההחזר גדול מהסכום הניתן להחזר", "INVALID", { refundableAgorot: cap });
      const created = await createPendingRefund(tx, { paymentId: payment.id, amountAgorot: refundAgorot, reason: `package_cancellation:${req.id}`, adminId: input.adminId, idempotencyKey: `pkgcancel:${req.id}` });
      refundId = created.refund.id;
    }

    // איפוס היתרה: אין ניצול נוסף. הדקות שנותרו נרשמות כתנועה כדי שההיסטוריה תתאזן
    const forfeited = pkg.minutesRemaining;
    await tx.hoursPackage.update({ where: { id: pkg.id }, data: { minutesRemaining: 0, cancelledAt: now, cancelledById: input.adminId } });
    if (forfeited > 0) await tx.packageUsage.create({ data: { packageId: pkg.id, kind: "CONSUME", minutes: forfeited } });
    await tx.packageCancellationRequest.update({
      where: { id: req.id },
      data: { status: "APPROVED", decidedAt: now, decidedById: input.adminId, decisionNote: reason, refundAgorot, refundId, forfeitedMinutes: forfeited },
    });
    await writeAudit(tx, {
      action: "PACKAGE_CANCEL_APPROVED",
      adminId: input.adminId,
      userId: req.userId,
      entityType: "PackageCancellationRequest",
      entityId: req.id,
      paymentId: pkg.paymentId,
      outcome: "ok",
      reason,
      before: { packageId: pkg.id, minutesRemaining: forfeited, pricePaidAgorot: pkg.pricePaidAgorot },
      after: { minutesRemaining: 0, refundAgorot, forfeitedMinutes: forfeited },
    });
    return { refundId, forfeited };
  });

  let refundStatus: string | null = null;
  if (approved.refundId) {
    const res = await executeRefund({ refundId: approved.refundId, provider: input.provider, adminId: input.adminId });
    refundStatus = res.status;
  }
  return { decision: "APPROVE" as const, refundId: approved.refundId, refundStatus, forfeitedMinutes: approved.forfeited as number | null };
}
