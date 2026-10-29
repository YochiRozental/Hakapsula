import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { getBalanceView } from "@/lib/payments/views";
import { toDebtView } from "@/lib/finance/debts";
import { listAudit } from "@/lib/finance/audit";
import { listRefundExceptions } from "@/lib/finance/refunds";
import { STUCK_PAYMENT_MS } from "@/lib/finance/unknown";

/**
 * תמונת מצב כספית. ההפרדה בין סוגי הכסף היא מהותית ואינה מחושבת מהזמנות:
 *   נגבה בפועל      = תשלומים שהספק אישר (Payment SUCCEEDED), ברוטו, ופחות מזה: החזרים שבוצעו בפועל (Refund SUCCEEDED).
 *   חוב שטרם נגבה   = יתרת חובות פתוחים (Debt) + חיובי משמרת שלא נגבו (ShiftCharge). שתי הקבוצות זרות זו לזו: חוב נוצר רק
 *                     להזמנת מנהל ללא תשלום, וחיוב משמרת הוא ההתחייבות של המשמרת עצמה; לעולם אין Debt על מופע של משמרת.
 *   החזר שממתין     = Refund PENDING (כולל כאלה שמצבם לא ידוע) + חריגי החזר שממתינים להכרעה (סכום פוטנציאלי בלבד).
 *   נמחל            = ויתורי מנהל; אינו הכנסה ואינו חוב.
 * סכומים באגורות שלמות; הטווח חל על תנועות (תשלומים/החזרים/ויתורים), לא על יתרות נוכחיות (חובות פתוחים וכד').
 */

export interface Range {
  from?: Date;
  to?: Date;
}

const between = (r: Range) => (r.from || r.to ? { gte: r.from, lt: r.to } : undefined);

export async function getFinanceOverview(range: Range = {}, includeShifts = true, now: Date = new Date()) {
  const dateFilter = between(range);
  const stuckBefore = new Date(now.getTime() - STUCK_PAYMENT_MS);

  const [paid, failed, stuck, refundsDone, refundsPending, refundsFailed, debts, waived, paidDown, cancelPending, exceptions, audits, shiftFailed, shiftPending, shiftUnknown, graceShifts, suspended] =
    await Promise.all([
      prisma.payment.aggregate({ where: { status: "SUCCEEDED", ...(dateFilter ? { paidAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.payment.aggregate({ where: { status: "FAILED", ...(dateFilter ? { createdAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.payment.aggregate({ where: { status: "PENDING", purpose: { in: ["BOOKING", "PACKAGE", "DEBT"] }, createdAt: { lte: stuckBefore } }, _sum: { amountAgorot: true }, _count: true }),
      prisma.refund.aggregate({ where: { status: "SUCCEEDED", ...(dateFilter ? { createdAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.refund.aggregate({ where: { status: "PENDING" }, _sum: { amountAgorot: true }, _count: true }),
      prisma.refund.aggregate({ where: { status: "FAILED", ...(dateFilter ? { createdAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.debt.findMany({ where: { status: { in: ["OPEN", "IN_REVIEW"] } }, select: { status: true, amountAgorot: true, paidAgorot: true, waivedAgorot: true } }),
      prisma.debtSettlement.aggregate({ where: { kind: "WAIVER", ...(dateFilter ? { createdAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.debtSettlement.aggregate({ where: { kind: "PAYMENT", ...(dateFilter ? { createdAt: dateFilter } : {}) }, _sum: { amountAgorot: true }, _count: true }),
      prisma.packageCancellationRequest.count({ where: { status: "PENDING" } }),
      listRefundExceptions(),
      prisma.auditLog.groupBy({
        by: ["action"],
        where: { action: { in: ["DEBT_WAIVED", "REFUND_EXCEPTION_REQUESTED", "REFUND_EXCEPTION_APPROVED", "REFUND_RESOLVED_MANUAL", "PAYMENT_RESOLVED_MANUAL", "SHIFT_CHARGE_UNKNOWN_RESOLVED", "CUSTOMER_BLOCKED", "BOOKING_APPROVED_WITH_DEBT", "PACKAGE_CANCEL_APPROVED"] }, ...(dateFilter ? { createdAt: dateFilter } : {}) },
        _count: true,
      }),
      includeShifts ? prisma.shiftCharge.aggregate({ where: { status: "FAILED" }, _sum: { amountAgorot: true }, _count: true }) : null,
      includeShifts ? prisma.shiftCharge.aggregate({ where: { status: "PENDING" }, _sum: { amountAgorot: true }, _count: true }) : null,
      includeShifts ? prisma.shiftCharge.aggregate({ where: { status: "UNKNOWN" }, _sum: { amountAgorot: true }, _count: true }) : null,
      includeShifts ? prisma.shift.count({ where: { status: "ACTIVE", charges: { some: { status: "FAILED", graceUntil: { gt: now } } } } }) : 0,
      includeShifts ? prisma.shift.count({ where: { status: "SUSPENDED" } }) : 0,
    ]);

  const sum = (a: { _sum: { amountAgorot: number | null } } | null) => a?._sum.amountAgorot ?? 0;
  const grossCollected = sum(paid);
  const refundedDone = sum(refundsDone);
  const debtOpen = debts.filter((d) => d.status === "OPEN").reduce((n, d) => n + d.amountAgorot - d.paidAgorot - d.waivedAgorot, 0);
  const debtReview = debts.filter((d) => d.status === "IN_REVIEW").reduce((n, d) => n + d.amountAgorot - d.paidAgorot - d.waivedAgorot, 0);
  const shiftArrears = sum(shiftFailed) + sum(shiftPending);

  return {
    environmentNote: "כל הנתונים בסביבת בדיקות (Mock)",
    range: { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null },
    collected: {
      grossAgorot: grossCollected,
      count: paid._count,
      refundedAgorot: refundedDone,
      netAgorot: grossCollected - refundedDone,
    },
    failedPayments: { count: failed._count, agorot: sum(failed) },
    unknownPayments: { count: stuck._count + (shiftUnknown?._count ?? 0), agorot: sum(stuck) + sum(shiftUnknown), stuckPayments: stuck._count, unknownShiftCharges: shiftUnknown?._count ?? 0 },
    debts: {
      openCount: debts.filter((d) => d.status === "OPEN").length,
      openAgorot: debtOpen,
      inReviewCount: debts.filter((d) => d.status === "IN_REVIEW").length,
      inReviewAgorot: debtReview,
      waivedAgorot: sum(waived),
      waivedCount: waived._count,
      paidDownAgorot: sum(paidDown),
      paidDownCount: paidDown._count,
    },
    refunds: {
      doneCount: refundsDone._count,
      doneAgorot: refundedDone,
      pendingCount: refundsPending._count,
      pendingAgorot: sum(refundsPending),
      failedCount: refundsFailed._count,
      failedAgorot: sum(refundsFailed),
      exceptionsAwaitingCount: exceptions.length,
      exceptionsAwaitingAgorot: exceptions.reduce((n, e) => n + e.refundableAgorot, 0),
    },
    packageCancellationRequestsPending: cancelPending,
    shifts: includeShifts
      ? {
          failedChargesCount: shiftFailed?._count ?? 0,
          failedChargesAgorot: sum(shiftFailed),
          pendingChargesCount: shiftPending?._count ?? 0,
          pendingChargesAgorot: sum(shiftPending),
          unknownChargesCount: shiftUnknown?._count ?? 0,
          unknownChargesAgorot: sum(shiftUnknown),
          graceShifts,
          suspendedShifts: suspended,
        }
      : null,
    /** חוב שטרם נגבה, מופרד מהכסף שנגבה: חובות הזמנות + חיובי משמרת שלא נגבו (קבוצות זרות, ללא ספירה כפולה) */
    outstandingNotCollectedAgorot: debtOpen + debtReview + shiftArrears,
    outstandingBreakdown: { bookingDebtsAgorot: debtOpen + debtReview, shiftArrearsAgorot: shiftArrears },
    unusualAdminActions: audits.map((a) => ({ action: a.action, count: a._count })),
  };
}

// ───────────────────────────── ספר תנועות מאוחד ─────────────────────────────

export interface LedgerFilters extends Range {
  userId?: string;
  q?: string;
  /** PAYMENT | REFUND | DEBT_SETTLEMENT | ALL */
  type?: string;
  status?: string;
}

export interface LedgerRow {
  key: string;
  at: string;
  type: "PAYMENT" | "REFUND" | "DEBT_PAYMENT" | "DEBT_WAIVER";
  label: string;
  user: { id: string; name: string };
  amountAgorot: number;
  status: string;
  ref: string;
}

export async function getLedger(f: LedgerFilters = {}): Promise<LedgerRow[]> {
  const q = f.q?.trim();
  const userWhere: Prisma.UserWhereInput | undefined = q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } : undefined;
  const dateFilter = between(f);
  const want = (t: string) => !f.type || f.type === "ALL" || f.type === t;
  const rows: LedgerRow[] = [];

  if (want("PAYMENT")) {
    const payments = await prisma.payment.findMany({
      where: { ...(f.userId ? { userId: f.userId } : {}), ...(userWhere ? { user: userWhere } : {}), ...(f.status ? { status: f.status as never } : {}), ...(dateFilter ? { createdAt: dateFilter } : {}) },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    for (const p of payments) {
      rows.push({ key: `p:${p.id}`, at: (p.paidAt ?? p.createdAt).toISOString(), type: "PAYMENT", label: p.purpose, user: p.user, amountAgorot: p.amountAgorot, status: p.status, ref: p.id });
    }
  }
  if (want("REFUND")) {
    const refunds = await prisma.refund.findMany({
      where: { ...(f.userId ? { payment: { userId: f.userId } } : {}), ...(userWhere ? { payment: { user: userWhere } } : {}), ...(f.status ? { status: f.status as never } : {}), ...(dateFilter ? { createdAt: dateFilter } : {}) },
      include: { payment: { include: { user: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    for (const r of refunds) rows.push({ key: `r:${r.id}`, at: r.createdAt.toISOString(), type: "REFUND", label: r.reason ?? "refund", user: r.payment.user, amountAgorot: r.amountAgorot, status: r.status, ref: r.id });
  }
  if (want("DEBT_SETTLEMENT") && (!f.status || f.status === "SUCCEEDED")) {
    const sets = await prisma.debtSettlement.findMany({
      where: { ...(f.userId ? { debt: { userId: f.userId } } : {}), ...(userWhere ? { debt: { user: userWhere } } : {}), ...(dateFilter ? { createdAt: dateFilter } : {}) },
      include: { debt: { include: { user: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    for (const s of sets) {
      rows.push({ key: `s:${s.id}`, at: s.createdAt.toISOString(), type: s.kind === "PAYMENT" ? "DEBT_PAYMENT" : "DEBT_WAIVER", label: s.reference ?? s.reason ?? s.kind, user: s.debt.user, amountAgorot: s.amountAgorot, status: "SUCCEEDED", ref: s.debtId });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
}

// ───────────────────────────── משמרות בתמונה הכספית ─────────────────────────────

export async function getShiftFinance(now: Date = new Date()) {
  const [charges, graceShifts, suspended] = await Promise.all([
    prisma.shiftCharge.findMany({
      where: { status: { in: ["FAILED", "UNKNOWN", "PENDING"] } },
      include: { shift: { include: { user: { select: { id: true, name: true } }, room: { select: { name: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    prisma.shift.findMany({ where: { status: "ACTIVE", charges: { some: { status: "FAILED", graceUntil: { gt: now } } } }, include: { user: { select: { id: true, name: true } }, room: { select: { name: true } }, charges: { where: { status: "FAILED" } } }, take: 100 }),
    prisma.shift.findMany({ where: { status: "SUSPENDED" }, include: { user: { select: { id: true, name: true } }, room: { select: { name: true } }, charges: { where: { status: { in: ["FAILED", "UNKNOWN", "PENDING"] } } } }, take: 100 }),
  ]);
  return {
    charges: charges.map((c) => ({
      id: c.id,
      shiftId: c.shiftId,
      status: c.status,
      month: c.month,
      amountAgorot: c.amountAgorot,
      failureCode: c.failureCode,
      graceUntil: c.graceUntil?.toISOString() ?? null,
      user: c.shift.user,
      room: c.shift.room.name,
      shiftStatus: c.shift.status,
    })),
    graceShifts: graceShifts.map((s) => ({ id: s.id, user: s.user, room: s.room.name, weekday: s.weekday, windowId: s.windowId, owedAgorot: s.charges.reduce((n, c) => n + c.amountAgorot, 0), graceUntil: s.charges.map((c) => c.graceUntil).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null })),
    suspendedShifts: suspended.map((s) => ({ id: s.id, user: s.user, room: s.room.name, weekday: s.weekday, windowId: s.windowId, reason: s.suspensionReason, owedAgorot: s.charges.reduce((n, c) => n + c.amountAgorot, 0) })),
  };
}

// ───────────────────────────── כרטיס לקוח כספי ─────────────────────────────

export async function searchCustomers(q: string) {
  const text = q.trim();
  if (text.length < 2) return [];
  return prisma.user.findMany({
    where: { role: "CLIENT", OR: [{ name: { contains: text, mode: "insensitive" } }, { email: { contains: text, mode: "insensitive" } }, { phone: { contains: text } }] },
    select: { id: true, name: true, email: true, phone: true, status: true },
    orderBy: { name: "asc" },
    take: 20,
  });
}

export async function getCustomerFinance(userId: string, includeShifts = true, now: Date = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, phone: true, status: true, role: true, canBookShifts: true } });
  if (!user || user.role !== "CLIENT") return null;
  const [payments, refunds, debts, packages, requests, shifts, audit, balance] = await Promise.all([
    prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.refund.findMany({ where: { payment: { userId } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.debt.findMany({
      where: { userId },
      include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } }, appointment: { include: { room: { select: { name: true } } } }, settlements: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.hoursPackage.findMany({ where: { userId }, orderBy: { purchasedAt: "desc" } }),
    prisma.packageCancellationRequest.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    includeShifts
      ? prisma.shift.findMany({ where: { userId }, include: { room: { select: { name: true } }, charges: { orderBy: { month: "asc" } } }, orderBy: { createdAt: "desc" } })
      : Promise.resolve([]),
    listAudit({ userId, take: 50 }),
    getBalanceView(userId, now),
  ]);
  return {
    user,
    blocked: user.status === "BLOCKED",
    payments: payments.map((p) => ({ id: p.id, purpose: p.purpose, status: p.status, amountAgorot: p.amountAgorot, createdAt: p.createdAt.toISOString(), paidAt: p.paidAt?.toISOString() ?? null })),
    refunds: refunds.map((r) => ({ id: r.id, paymentId: r.paymentId, status: r.status, amountAgorot: r.amountAgorot, reason: r.reason, createdAt: r.createdAt.toISOString() })),
    debts: debts.map(toDebtView),
    packages: packages.map((p) => ({
      id: p.id,
      hours: p.hours,
      pricePaidAgorot: p.pricePaidAgorot,
      minutesRemaining: p.minutesRemaining,
      minutesTotal: p.minutesTotal,
      expiresAt: p.expiresAt.toISOString(),
      expired: p.expiresAt.getTime() <= now.getTime(),
      cancelledAt: p.cancelledAt?.toISOString() ?? null,
    })),
    balance,
    cancellationRequests: requests.map((r) => ({ id: r.id, packageId: r.packageId, status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString(), decisionNote: r.decisionNote, refundAgorot: r.refundAgorot })),
    shifts: shifts.map((s) => ({
      id: s.id,
      room: s.room.name,
      weekday: s.weekday,
      windowId: s.windowId,
      status: s.status,
      suspensionReason: s.suspensionReason,
      charges: s.charges.map((c) => ({ id: c.id, month: c.month, status: c.status, amountAgorot: c.amountAgorot, failureCode: c.failureCode })),
    })),
    audit,
  };
}
