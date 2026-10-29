import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/finance/audit";
import { FinanceError, requireReason } from "@/lib/finance/errors";

/**
 * חסימה ושחרור של לקוח מהזמנות עתידיות (מנהל בלבד). משתמשת במנגנון הקיים: סטטוס BLOCKED, שכבר מונע הזמנה באתר, בטלפון
 * וביצירת משמרת (כולם דורשים APPROVED). חוב פתוח לבדו אינו חוסם; רק החלטה מפורשת זו. הזמנות קיימות אינן מבוטלות.
 * הפעולה מתועדת עם סיבה ועם המצב לפני ואחרי, באותה טרנזקציה.
 */
export async function setCustomerBlock(input: { adminId: string; userId: string; blocked: boolean; reason: unknown }) {
  const reason = requireReason(input.reason);
  if (input.adminId === input.userId) throw new FinanceError("לא ניתן לחסום את החשבון של עצמך", "INVALID");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, role: true, status: true } });
    if (!user || user.role !== "CLIENT") throw new FinanceError("הלקוח לא נמצא", "NOT_FOUND");
    if (input.blocked) {
      if (user.status === "BLOCKED") throw new FinanceError("הלקוח כבר חסום", "CONFLICT");
    } else if (user.status !== "BLOCKED") {
      throw new FinanceError("הלקוח אינו חסום", "CONFLICT");
    }
    const next = input.blocked ? "BLOCKED" : "APPROVED";
    await tx.user.update({ where: { id: user.id }, data: { status: next } });
    await writeAudit(tx, {
      action: input.blocked ? "CUSTOMER_BLOCKED" : "CUSTOMER_UNBLOCKED",
      adminId: input.adminId,
      userId: user.id,
      entityType: "User",
      entityId: user.id,
      outcome: "ok",
      reason,
      before: { status: user.status },
      after: { status: next },
    });
    return { userId: user.id, status: next };
  });
}
