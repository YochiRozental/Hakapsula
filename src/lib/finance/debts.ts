import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { debtRemaining } from "@/lib/payments/debts";
import { writeAudit } from "@/lib/finance/audit";
import { FinanceError, requireAgorot, requireClientKey, requireReason } from "@/lib/finance/errors";

/**
 * ניהול חובות (שלב H) מעל מודל Debt הקיים. חוב לעולם לא נמחק ולעולם לא נסגר ללא תיעוד:
 *  - הסדרה בתשלום: רק תשלום חיצוני שהמנהל אישר במפורש, עם אסמכתה (או תשלום שאומת מול הספק), וסכום עד היתרה.
 *  - ויתור: סיבה חובה; ניתן חלקי.
 *  - כל שינוי נעשה תחת נעילת שורת החוב, עם מפתח אידמפוטנטיות, ונרשם ליומן הביקורת באותה טרנזקציה.
 * חוב פתוח אינו חוסם הזמנות; רק חסימה מפורשת של לקוח (blocks.ts) חוסמת.
 */

type Tx = Prisma.TransactionClient;

async function lockDebt(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Debt" WHERE id = ${id} FOR UPDATE`;
  const debt = await tx.debt.findUnique({ where: { id } });
  if (!debt) throw new FinanceError("החוב לא נמצא", "NOT_FOUND");
  return debt;
}

const snapshot = (d: { status: string; amountAgorot: number; paidAgorot: number; waivedAgorot: number }) => ({
  status: d.status,
  amountAgorot: d.amountAgorot,
  paidAgorot: d.paidAgorot,
  waivedAgorot: d.waivedAgorot,
  remainingAgorot: debtRemaining(d),
});

/** מצב סגירה לפי הסכומים: שולם (אין ויתור) או נסגר בוויתור (כולל תשלום חלקי + ויתור על היתרה) */
function closedStatus(d: { paidAgorot: number; waivedAgorot: number }) {
  return d.waivedAgorot > 0 ? ("WAIVED" as const) : ("PAID" as const);
}

export interface SettleExternalInput {
  debtId: string;
  adminId: string;
  amountAgorot: unknown;
  /** תשלום חיצוני: חובה אסמכתה (קבלה/העברה) ואישור מפורש שהתשלום התקבל */
  reference: unknown;
  confirmedExternalPayment: unknown;
  note?: unknown;
  clientKey: unknown;
}

export async function settleDebtExternal(input: SettleExternalInput) {
  const amount = requireAgorot(input.amountAgorot);
  const key = requireClientKey(input.clientKey);
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  if (reference.length < 3) throw new FinanceError("יש להזין אסמכתה לתשלום (מספר קבלה, העברה וכד')", "INVALID");
  if (input.confirmedExternalPayment !== true) throw new FinanceError("יש לאשר במפורש שהתשלום התקבל מחוץ למערכת", "INVALID");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : null;
  const idempotencyKey = `debt-settle:${input.debtId}:${key}`;

  return prisma.$transaction(async (tx) => {
    const debt = await lockDebt(tx, input.debtId);
    const replay = await tx.debtSettlement.findUnique({ where: { idempotencyKey } });
    if (replay) return { debt, settlement: replay, replayed: true };
    if (debt.status !== "OPEN") throw new FinanceError(debt.status === "IN_REVIEW" ? "החוב בבירור; יש להכריע בבירור לפני הסדרה" : "החוב כבר סגור", "CONFLICT");
    const remaining = debtRemaining(debt);
    if (amount > remaining) throw new FinanceError("הסכום גדול מיתרת החוב", "INVALID", { remainingAgorot: remaining });

    const settlement = await tx.debtSettlement.create({
      data: { debtId: debt.id, kind: "PAYMENT", amountAgorot: amount, method: "EXTERNAL", reference: reference.slice(0, 120), reason: note, createdById: input.adminId, idempotencyKey },
    });
    const paidAgorot = debt.paidAgorot + amount;
    const closes = paidAgorot + debt.waivedAgorot === debt.amountAgorot;
    const updated = await tx.debt.update({
      where: { id: debt.id },
      data: { paidAgorot, ...(closes ? { status: closedStatus({ paidAgorot, waivedAgorot: debt.waivedAgorot }), resolvedAt: new Date(), resolvedById: input.adminId } : {}) },
    });
    await writeAudit(tx, {
      action: "DEBT_SETTLED",
      adminId: input.adminId,
      userId: debt.userId,
      entityType: "Debt",
      entityId: debt.id,
      outcome: "ok",
      reason: note ?? `external:${reference.slice(0, 60)}`,
      before: snapshot(debt),
      after: { ...snapshot(updated), settledAgorot: amount, method: "EXTERNAL" },
    });
    return { debt: updated, settlement, replayed: false };
  });
}

export async function waiveDebt(input: { debtId: string; adminId: string; amountAgorot?: unknown; reason: unknown; clientKey: unknown }) {
  const reason = requireReason(input.reason);
  const key = requireClientKey(input.clientKey);
  const idempotencyKey = `debt-waive:${input.debtId}:${key}`;

  return prisma.$transaction(async (tx) => {
    const debt = await lockDebt(tx, input.debtId);
    const replay = await tx.debtSettlement.findUnique({ where: { idempotencyKey } });
    if (replay) return { debt, settlement: replay, replayed: true };
    if (debt.status !== "OPEN" && debt.status !== "IN_REVIEW") throw new FinanceError("החוב כבר סגור", "CONFLICT");
    const remaining = debtRemaining(debt);
    const amount = input.amountAgorot === undefined ? remaining : requireAgorot(input.amountAgorot);
    if (amount > remaining) throw new FinanceError("הסכום גדול מיתרת החוב", "INVALID", { remainingAgorot: remaining });

    const settlement = await tx.debtSettlement.create({
      data: { debtId: debt.id, kind: "WAIVER", amountAgorot: amount, reason, createdById: input.adminId, idempotencyKey },
    });
    const waivedAgorot = debt.waivedAgorot + amount;
    const closes = debt.paidAgorot + waivedAgorot === debt.amountAgorot;
    const updated = await tx.debt.update({
      where: { id: debt.id },
      data: { waivedAgorot, ...(closes ? { status: "WAIVED", resolvedAt: new Date(), resolvedById: input.adminId } : {}) },
    });
    await writeAudit(tx, {
      action: "DEBT_WAIVED",
      adminId: input.adminId,
      userId: debt.userId,
      entityType: "Debt",
      entityId: debt.id,
      outcome: "ok",
      reason,
      before: snapshot(debt),
      after: { ...snapshot(updated), waivedNowAgorot: amount },
    });
    return { debt: updated, settlement, replayed: false };
  });
}

/** סימון חוב כממתין לבירור (ובחזרה לפתוח). חוב בבירור לא ניתן להסדרה בתשלום עד הכרעה */
export async function setDebtReview(input: { debtId: string; adminId: string; inReview: boolean; note: unknown }) {
  const note = requireReason(input.note);
  return prisma.$transaction(async (tx) => {
    const debt = await lockDebt(tx, input.debtId);
    const from = input.inReview ? "OPEN" : "IN_REVIEW";
    if (debt.status !== from) throw new FinanceError(input.inReview ? "ניתן להעביר לבירור רק חוב פתוח" : "החוב אינו בבירור", "CONFLICT");
    const updated = await tx.debt.update({ where: { id: debt.id }, data: input.inReview ? { status: "IN_REVIEW", reviewNote: note } : { status: "OPEN", reviewNote: null } });
    await writeAudit(tx, {
      action: input.inReview ? "DEBT_REVIEW_OPENED" : "DEBT_REVIEW_CLOSED",
      adminId: input.adminId,
      userId: debt.userId,
      entityType: "Debt",
      entityId: debt.id,
      outcome: "ok",
      reason: note,
      before: snapshot(debt),
      after: snapshot(updated),
    });
    return updated;
  });
}

// ───────────────────────────── תצוגה ─────────────────────────────

export interface DebtFilters {
  userId?: string;
  q?: string;
  status?: string;
  from?: Date;
  to?: Date;
  minAgorot?: number;
  maxAgorot?: number;
}

const include = {
  user: { select: { id: true, name: true, email: true, phone: true, status: true } },
  appointment: { include: { room: { select: { name: true } } } },
  settlements: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.DebtInclude;

type DebtRow = Prisma.DebtGetPayload<{ include: typeof include }>;

export function toDebtView(d: DebtRow) {
  const remaining = debtRemaining(d);
  const classification =
    d.status === "PAID" ? "PAID_ACTUAL" : d.status === "WAIVED" ? "WAIVED" : d.status === "IN_REVIEW" ? "IN_REVIEW" : "OPEN";
  return {
    id: d.id,
    user: d.user,
    status: d.status,
    classification,
    amountAgorot: d.amountAgorot,
    paidAgorot: d.paidAgorot,
    waivedAgorot: d.waivedAgorot,
    remainingAgorot: remaining,
    reason: d.reason,
    reviewNote: d.reviewNote,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    source: d.appointment
      ? {
          kind: "BOOKING" as const,
          appointmentId: d.appointment.id,
          roomName: d.appointment.room.name,
          startTime: d.appointment.startTime.toISOString(),
          endTime: d.appointment.endTime.toISOString(),
          appointmentStatus: d.appointment.status,
        }
      : { kind: "MANUAL" as const },
    settlements: d.settlements.map((s) => ({
      id: s.id,
      kind: s.kind,
      amountAgorot: s.amountAgorot,
      method: s.method,
      reference: s.reference,
      reason: s.reason,
      paymentId: s.paymentId,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export async function listDebts(f: DebtFilters = {}) {
  const q = f.q?.trim();
  const where: Prisma.DebtWhereInput = {
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.status ? { status: f.status as never } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
    ...(f.minAgorot !== undefined || f.maxAgorot !== undefined ? { amountAgorot: { ...(f.minAgorot !== undefined ? { gte: f.minAgorot } : {}), ...(f.maxAgorot !== undefined ? { lte: f.maxAgorot } : {}) } } : {}),
    ...(q ? { user: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } } : {}),
  };
  const rows = await prisma.debt.findMany({ where, include, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(toDebtView);
}

export async function getDebt(id: string) {
  const row = await prisma.debt.findUnique({ where: { id }, include });
  return row ? toDebtView(row) : null;
}
