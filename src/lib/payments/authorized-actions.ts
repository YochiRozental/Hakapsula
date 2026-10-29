import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { consumeAuthorization } from "@/lib/payments/authorization";
import { confirmBookingFromBalance, payBookingWithSavedCard, type FinalizeOutcome } from "@/lib/payments/booking-payment";
import type { PaymentProvider } from "@/lib/payments/provider";
import { PaymentFlowError } from "@/lib/payments/shared";

/**
 * ביצוע פעולה כספית בטלפון, רק מכוח הרשאה חד-פעמית (authorization.ts). ההרשאה נצרכת אטומית לפני כל פעולה, ולכן בקשה
 * חוזרת, שיחה מקבילה או נסיון להשתמש באותה הרשאה שוב לא יבצעו פעולה נוספת. הפעולה עצמה עוברת דרך שירותי שלבים C+D
 * (confirm-balance / חיוב כרטיס שמור + finalizeBookingPayment), בלי שום מסלול תשלום מקביל.
 *
 * ההרשאה נשרפת גם אם הפעולה נכשלה: ניסיון נוסף מחייב אימות קוד חדש.
 */

export type AuthorizedBookingResult =
  | { status: "CONFIRMED"; via: "BALANCE" | "CARD"; paidFromBalanceMinutes: number; paidCashAgorot: number }
  /** ההרשאה פגה, כבר נוצלה, או אינה שייכת למשתמש/להזמנה הזו */
  | { status: "AUTH_INVALID" }
  | { status: "HOLD_EXPIRED" }
  | { status: "INSUFFICIENT_BALANCE" }
  | { status: "PLAN_CHANGED" }
  | { status: "NO_PAYMENT_METHOD" }
  | { status: "PAYMENT_FAILED" }
  /** התשלום התקבל אך ההזמנה לא אושרה, והכסף הוחזר במלואו; לא נוכו דקות */
  | { status: "REFUNDED"; reason: "LATE" | "BALANCE_CHANGED" }
  | { status: "REFUND_PENDING" }
  | { status: "PROVIDER_ERROR" }
  | { status: "NOT_COMPLETED" };

const fromOutcome = (outcome: FinalizeOutcome): AuthorizedBookingResult["status"] | "CONFIRMED" | "REFUNDED_LATE" | "REFUNDED_BALANCE" => {
  switch (outcome) {
    case "CONFIRMED":
    case "ALREADY_CONFIRMED":
      return "CONFIRMED";
    case "PAYMENT_FAILED":
    case "PAYMENT_CANCELLED":
      return "PAYMENT_FAILED";
    case "LATE_REFUNDED":
      return "REFUNDED_LATE";
    case "BALANCE_CHANGED_REFUNDED":
      return "REFUNDED_BALANCE";
    case "LATE_REFUND_FAILED":
    case "BALANCE_CHANGED_REFUND_FAILED":
      return "REFUND_PENDING";
    default:
      return "NOT_COMPLETED";
  }
};

export async function executeAuthorizedBooking(params: {
  authorizationId: string;
  userId: string;
  appointmentId: string;
  provider: PaymentProvider;
  db?: PrismaClient;
  now?: Date;
  hooks?: { beforeApply?: () => Promise<void> };
}): Promise<AuthorizedBookingResult> {
  const { authorizationId, userId, appointmentId, provider, db = defaultDb, now = new Date(), hooks } = params;

  const auth = await consumeAuthorization({ id: authorizationId, userId, appointmentId, db, now });
  if (!auth) return { status: "AUTH_INVALID" };

  try {
    if (auth.action === "CONFIRM_BALANCE") {
      const appt = await db.appointment.findUnique({ where: { id: appointmentId }, select: { startTime: true, endTime: true } });
      const minutes = appt ? (appt.endTime.getTime() - appt.startTime.getTime()) / 60_000 : -1;
      // ההרשאה אושרה לניכוי מלא של ההזמנה מהיתרה; כל חלוקה אחרת אינה מה שהלקוח אישר
      if (!appt || auth.amountAgorot !== 0 || auth.packageMinutes !== minutes) return { status: "PLAN_CHANGED" };
      const res = await confirmBookingFromBalance({ appointmentId, userId, provider, now });
      return { status: "CONFIRMED", via: "BALANCE", paidFromBalanceMinutes: res.minutes, paidCashAgorot: 0 };
    }

    const result = await payBookingWithSavedCard({
      appointmentId,
      userId,
      provider,
      expected: { cashAgorot: auth.amountAgorot, packageMinutes: auth.packageMinutes },
      now,
      hooks,
    });
    const mapped = fromOutcome(result.outcome);
    if (mapped === "CONFIRMED") {
      return { status: "CONFIRMED", via: "CARD", paidFromBalanceMinutes: auth.packageMinutes, paidCashAgorot: auth.amountAgorot };
    }
    if (mapped === "REFUNDED_LATE") return { status: "REFUNDED", reason: "LATE" };
    if (mapped === "REFUNDED_BALANCE") return { status: "REFUNDED", reason: "BALANCE_CHANGED" };
    return { status: mapped } as AuthorizedBookingResult;
  } catch (err) {
    if (err instanceof PaymentFlowError) {
      switch (err.code) {
        case "EXPIRED":
        case "CONFLICT":
        case "NOT_FOUND":
          return { status: "HOLD_EXPIRED" };
        case "INSUFFICIENT_BALANCE":
          return { status: "INSUFFICIENT_BALANCE" };
        case "PLAN_CHANGED":
          return { status: "PLAN_CHANGED" };
        case "NO_PAYMENT_METHOD":
          return { status: "NO_PAYMENT_METHOD" };
        case "PROVIDER_ERROR":
          return { status: "PROVIDER_ERROR" };
      }
    }
    throw err;
  }
}
