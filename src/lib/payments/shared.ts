import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { PaymentProvider } from "@/lib/payments/provider";

/** עזרים משותפים לשירותי התשלום (הזמנות, חבילות, יתרות) */

export type Tx = Prisma.TransactionClient;

export type FlowErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "EXPIRED"
  | "INVALID"
  | "CONFLICT"
  | "INSUFFICIENT_BALANCE"
  /** חלוקת התשלום (סכום/דקות) השתנתה מאז שהוצגה ללקוח ואושרה */
  | "PLAN_CHANGED"
  /** אין אמצעי תשלום שמור שאפשר לחייב */
  | "NO_PAYMENT_METHOD"
  /** כשל בספק התשלום (לא ידוע אם בוצע חיוב) */
  | "PROVIDER_ERROR";

export class PaymentFlowError extends Error {
  constructor(
    message: string,
    readonly code: FlowErrorCode
  ) {
    super(message);
    this.name = "PaymentFlowError";
  }
}

export function environmentOf(provider: PaymentProvider) {
  return provider.environment === "live" ? ("LIVE" as const) : ("SANDBOX" as const);
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002";
}

/** יומן ביקורת. לעולם לא כולל סודות/טוקנים/פרטי כרטיס; כשל ברישום לא מפיל את הפעולה */
export async function audit(paymentId: string, action: string, outcome: "ok" | "error", errorCode?: string, detail?: string) {
  try {
    await prisma.paymentAttempt.create({ data: { paymentId, action, outcome, errorCode, detail } });
  } catch (err) {
    console.error("[payments] audit write failed", err instanceof Error ? err.message : "unknown");
  }
}

/*
 * סדר נעילות עקבי בכל טרנזקציה (מונע deadlock):
 *   1) advisory lock של אזור החדר (lockRoomZone ב-booking.ts)   2) שורת ההזמנה   3) שורת התשלום   4) יתרות הלקוח
 * טרנזקציה לוקחת רק תת-קבוצה של הרשימה, תמיד באותו סדר יחסי.
 */

export async function lockAppointmentRow(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${id} FOR UPDATE`;
}

export async function lockPaymentRow(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${id} FOR UPDATE`;
}

/** נועל את כל החבילות והזיכויים של הלקוח (חבילות קודם, שניהם בסדר פקיעה ואז מזהה) */
export async function lockUserBalances(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT id FROM "HoursPackage" WHERE "userId" = ${userId} ORDER BY "expiresAt", id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Credit" WHERE "userId" = ${userId} ORDER BY "expiresAt", id FOR UPDATE`;
}
