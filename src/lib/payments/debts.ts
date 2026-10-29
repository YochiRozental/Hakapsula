import type { Tx } from "@/lib/payments/shared";

/** חוב פתוח = כל מה שלא שולם ולא נמחל. לעולם לא שלילי (גם אילוץ במסד) */
export const debtRemaining = (d: { amountAgorot: number; paidAgorot: number; waivedAgorot: number }) =>
  Math.max(0, d.amountAgorot - d.paidAgorot - d.waivedAgorot);

/**
 * מוותר על יתרת החוב הפתוח של הזמנה (ביטול מוקדם / חריג מנהל), בתוך טרנזקציה קיימת. שומר על אילוצי המסד:
 * הסכום שנמחל = היתרה שנותרה (תשלום חלקי קודם נשמר כפי שהיה). מחזיר true אם נסגר חוב.
 */
export async function waiveOpenDebtForAppointment(tx: Tx, appointmentId: string, adminId: string, now: Date, reason: string): Promise<boolean> {
  const debt = await tx.debt.findFirst({ where: { appointmentId, status: { in: ["OPEN", "IN_REVIEW"] } } });
  if (!debt) return false;
  const remaining = debtRemaining(debt);
  const { count } = await tx.debt.updateMany({
    where: { id: debt.id, status: { in: ["OPEN", "IN_REVIEW"] }, paidAgorot: debt.paidAgorot, waivedAgorot: debt.waivedAgorot },
    data: { status: "WAIVED", waivedAgorot: { increment: remaining }, resolvedAt: now, resolvedById: adminId },
  });
  if (count !== 1) return false;
  if (remaining > 0) {
    await tx.debtSettlement.create({
      data: { debtId: debt.id, kind: "WAIVER", amountAgorot: remaining, reason, createdById: adminId, idempotencyKey: `debt-waive-auto:${debt.id}` },
    });
  }
  return true;
}
