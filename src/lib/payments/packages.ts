import { prisma } from "@/lib/prisma";
import { findHoursPackage, packageExpiry, packageMinutes } from "@/lib/payments/pricing";
import type { PaymentProvider } from "@/lib/payments/provider";
import {
  PaymentFlowError,
  audit,
  environmentOf,
  isUniqueViolation,
  lockPaymentRow,
} from "@/lib/payments/shared";

/**
 * רכישת חבילות שעות. חבילה נוצרת אך ורק ב-finalizePackagePayment, אחרי שהסטטוס נשלף מהספק בצד השרת והסכום אומת
 * מול טבלת המחירים. אין "חבילה ממתינה": תשלום שנכשל או לא הושלם לא יוצר יתרה.
 */

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export interface StartedPackagePurchase {
  paymentId: string;
  providerPaymentId?: string;
  checkoutUrl?: string;
  hours: number;
  amountAgorot: number;
  status: string;
}

/**
 * פותח רכישת חבילה. המחיר נקבע בשרת מטבלת המחירים לפי מספר השעות בלבד (שום סכום מהלקוח).
 * clientKey: מפתח אקראי שהלקוח יוצר פעם אחת לכל "כוונת רכישה". אותו מפתח (לחיצה כפולה, רענון) מחזיר את אותו תשלום;
 * רכישה נוספת מכוונת של אותה חבילה משתמשת במפתח חדש.
 */
export async function startPackagePurchase(params: {
  userId: string;
  hours: number;
  clientKey: string;
  provider: PaymentProvider;
}): Promise<StartedPackagePurchase> {
  const { userId, hours, clientKey, provider } = params;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (!user) throw new PaymentFlowError("המשתמש לא נמצא", "NOT_FOUND");
  // התפקיד והסטטוס נבדקים מול המסד ולא מול ה-session
  if (user.role !== "CLIENT" || user.status !== "APPROVED") {
    throw new PaymentFlowError("רק לקוח מאושר רשאי לרכוש חבילה", "FORBIDDEN");
  }
  const option = findHoursPackage(hours);
  if (!option) throw new PaymentFlowError("חבילה לא קיימת", "INVALID");
  if (!CLIENT_KEY.test(clientKey)) throw new PaymentFlowError("מפתח הבקשה אינו תקין", "INVALID");

  const idempotencyKey = `package:${userId}:${clientKey}`;
  let payment;
  try {
    payment = await prisma.payment.create({
      data: {
        userId,
        purpose: "PACKAGE",
        packageHours: option.hours,
        amountAgorot: option.priceAgorot,
        status: "PENDING",
        environment: environmentOf(provider),
        provider: provider.name,
        idempotencyKey,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    payment = await prisma.payment.findUniqueOrThrow({ where: { idempotencyKey } });
    if (payment.userId !== userId || payment.purpose !== "PACKAGE" || payment.packageHours !== option.hours) {
      throw new PaymentFlowError("מפתח הבקשה כבר שימש לרכישה אחרת", "CONFLICT");
    }
  }

  if (payment.status !== "PENDING") {
    return {
      paymentId: payment.id,
      providerPaymentId: payment.providerPaymentId ?? undefined,
      hours: option.hours,
      amountAgorot: payment.amountAgorot,
      status: payment.status,
    };
  }

  // אידמפוטנטי מול הספק לפי אותו מפתח: קריסה לפני שמירת המזהה לא תיצור תשלום שני
  const request = await provider.createPaymentRequest({
    amountAgorot: payment.amountAgorot,
    currency: "ILS",
    description: `רכישת חבילת ${option.hours} שעות`,
    idempotencyKey: payment.idempotencyKey,
    customerRef: userId,
    metadata: { packageHours: String(option.hours) },
  });
  if (!payment.providerPaymentId) {
    await prisma.payment.updateMany({
      where: { id: payment.id, providerPaymentId: null },
      data: { providerPaymentId: request.providerPaymentId },
    });
    await audit(payment.id, "create", "ok");
  }
  return {
    paymentId: payment.id,
    providerPaymentId: request.providerPaymentId,
    checkoutUrl: request.checkoutUrl,
    hours: option.hours,
    amountAgorot: payment.amountAgorot,
    status: payment.status,
  };
}

export type PackageFinalizeOutcome =
  | "PACKAGE_ACTIVATED"
  | "ALREADY_ACTIVATED"
  | "PENDING"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "AMOUNT_MISMATCH";

export interface PackageFinalizeResult {
  outcome: PackageFinalizeOutcome;
  paymentId: string;
  packageId?: string;
}

/**
 * מאמת תשלום רכישה מול הספק ומפעיל את החבילה. אידמפוטנטי ובטוח להרצה מקבילית: HoursPackage.paymentId ייחודי,
 * ושורת התשלום נעולה, ולכן אותו תשלום לא ייצור שתי חבילות.
 */
export async function finalizePackagePayment(params: {
  paymentId: string;
  provider: PaymentProvider;
  now?: Date;
  /** נקודת הזרקה לבדיקות בלבד */
  beforeApply?: () => Promise<void>;
}): Promise<PackageFinalizeResult> {
  const { paymentId, provider, now = new Date(), beforeApply } = params;

  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { hoursPackage: true } });
  if (!payment || payment.purpose !== "PACKAGE") throw new PaymentFlowError("התשלום לא נמצא", "NOT_FOUND");
  if (payment.provider !== provider.name || payment.environment !== environmentOf(provider)) {
    throw new PaymentFlowError("התשלום אינו שייך לספק הנוכחי", "INVALID");
  }
  const result = (outcome: PackageFinalizeOutcome, packageId?: string): PackageFinalizeResult => ({
    outcome,
    paymentId: payment.id,
    packageId,
  });

  const option = payment.packageHours ? findHoursPackage(payment.packageHours) : undefined;
  // המחיר השמור חייב להתאים לטבלת המחירים (הגנה מפני שורה שנפגעה)
  if (!option || option.priceAgorot !== payment.amountAgorot) return result("AMOUNT_MISMATCH");

  if (payment.hoursPackage) return result("ALREADY_ACTIVATED", payment.hoursPackage.id);
  if (!payment.providerPaymentId) return result("PENDING");
  if (payment.status === "FAILED") return result("PAYMENT_FAILED");
  if (payment.status === "CANCELLED") return result("PAYMENT_CANCELLED");

  if (payment.status !== "SUCCEEDED") {
    const verified = await provider.getPaymentStatus(payment.providerPaymentId);
    if (verified.providerPaymentId !== payment.providerPaymentId) {
      throw new PaymentFlowError("תשובת הספק אינה תואמת לתשלום", "INVALID");
    }
    if (verified.amountAgorot !== payment.amountAgorot) {
      await audit(payment.id, "status", "error", "amount_mismatch");
      return result("AMOUNT_MISMATCH");
    }
    if (verified.status === "PENDING") return result("PENDING");
    if (verified.status === "FAILED" || verified.status === "CANCELLED") {
      await prisma.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: verified.status, failureCode: verified.failureCode ?? null },
      });
      await audit(payment.id, "status", "ok", verified.status.toLowerCase());
      return result(verified.status === "FAILED" ? "PAYMENT_FAILED" : "PAYMENT_CANCELLED");
    }
  }

  await beforeApply?.();

  try {
    const pkg = await prisma.$transaction(async (tx) => {
      await lockPaymentRow(tx, payment.id);
      const existing = await tx.hoursPackage.findUnique({ where: { paymentId: payment.id } });
      if (existing) return { id: existing.id, created: false };

      await tx.payment.updateMany({
        where: { id: payment.id, status: { not: "SUCCEEDED" } },
        data: { status: "SUCCEEDED", paidAt: now, failureCode: null },
      });
      const created = await tx.hoursPackage.create({
        data: {
          userId: payment.userId,
          hours: option.hours,
          pricePaidAgorot: payment.amountAgorot,
          minutesTotal: packageMinutes(option.hours),
          minutesRemaining: packageMinutes(option.hours),
          purchasedAt: now,
          expiresAt: packageExpiry(now),
          paymentId: payment.id,
        },
      });
      return { id: created.id, created: true };
    });
    if (pkg.created) await audit(payment.id, "status", "ok", "package_activated");
    return result(pkg.created ? "PACKAGE_ACTIVATED" : "ALREADY_ACTIVATED", pkg.id);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.hoursPackage.findUniqueOrThrow({ where: { paymentId: payment.id } });
    return result("ALREADY_ACTIVATED", existing.id);
  }
}

// ───────────────────────────── בקשת ביטול חבילה ─────────────────────────────

const MAX_CANCELLATION_REASON = 500;

/**
 * לקוח מגיש בקשה לבטל חבילה. הבקשה אינה מבטלת את החבילה, אינה מנכה יתרה ואינה מבצעת החזר: היא נרשמת לטיפול מנהל
 * (שלב H) בהתאם למדיניות ולדין. לכל חבילה לכל היותר בקשה פתוחה אחת (אינדקס ייחודי חלקי במסד, בטוח גם במקביל).
 * הבקשה נרשמת על שם המשתמש המחובר בלבד ורק לחבילה שבבעלותו.
 */
export async function requestPackageCancellation(params: {
  userId: string;
  packageId: string;
  reason?: string;
  now?: Date;
}) {
  const { userId, packageId, now = new Date() } = params;
  const reason = params.reason?.trim().slice(0, MAX_CANCELLATION_REASON) || null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "CLIENT") throw new PaymentFlowError("רק לקוח רשאי להגיש בקשה", "FORBIDDEN");

  // מסתירים קיום חבילה של אחרים
  const pkg = await prisma.hoursPackage.findFirst({ where: { id: packageId, userId } });
  if (!pkg) throw new PaymentFlowError("החבילה לא נמצאה", "NOT_FOUND");
  if (pkg.expiresAt.getTime() <= now.getTime() || pkg.minutesRemaining <= 0) {
    throw new PaymentFlowError("ניתן להגיש בקשת ביטול רק לחבילה פעילה שנותרה בה יתרה", "INVALID");
  }
  const approved = await prisma.packageCancellationRequest.count({ where: { packageId, status: "APPROVED" } });
  if (approved > 0) throw new PaymentFlowError("בקשת הביטול לחבילה זו כבר אושרה", "CONFLICT");

  try {
    const request = await prisma.packageCancellationRequest.create({ data: { packageId, userId, reason } });
    return { id: request.id, status: request.status, createdAt: request.createdAt };
  } catch (err) {
    if (isUniqueViolation(err)) throw new PaymentFlowError("כבר קיימת בקשת ביטול פתוחה לחבילה זו", "CONFLICT");
    throw err;
  }
}
