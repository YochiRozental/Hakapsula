import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { IVR_PIN_POLICY } from "@/lib/ivr-pin/policy";
import { recordSuccess, reserveAttempt } from "@/lib/ivr-pin/throttle";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import type { PaymentProvider } from "@/lib/payments/provider";
import { PaymentFlowError, environmentOf } from "@/lib/payments/shared";

/**
 * אמצעי תשלום שמורים. נשמרים אך ורק מזהה הספק, הטוקן ופרטי תצוגה מוסתרים (4 ספרות אחרונות, מותג, תוקף): לעולם לא
 * מספר כרטיס מלא או CVV. טוקן אינו מוחזר לשום ממשק או לוג.
 *
 * שלב זה מממש רק אמצעי תשלום מדומה (Mock, סביבת SANDBOX) לצורכי בדיקות. הוא נפרד לחלוטין מאמצעי תשלום אמיתי:
 * ה-Mock לא יכול לחייב שורה LIVE, וספק אמיתי לא יכול לחייב שורת SANDBOX (ראו findUsableCard).
 */

export const MAX_ACTIVE_METHODS = 3;

export interface PaymentMethodView {
  id: string;
  last4: string | null;
  brand: string | null;
  expiry: string | null;
  /** כרטיס מדומה לבדיקות בלבד */
  sandbox: boolean;
  createdAt: string;
}

type Row = { id: string; last4: string | null; brand: string | null; expiry: string | null; environment: string; createdAt: Date };

const toView = (r: Row): PaymentMethodView => ({
  id: r.id,
  last4: r.last4,
  brand: r.brand,
  expiry: r.expiry,
  sandbox: r.environment === "SANDBOX",
  createdAt: r.createdAt.toISOString(),
});

export async function listPaymentMethods(userId: string, db: PrismaClient = defaultDb): Promise<PaymentMethodView[]> {
  const rows = await db.paymentMethod.findMany({ where: { userId, active: true }, orderBy: { createdAt: "desc" } });
  return rows.map(toView);
}

export type AddMockCardResult =
  | { status: "OK"; method: PaymentMethodView }
  | { status: "INVALID_PASSWORD"; attemptsLeft: number }
  | { status: "BLOCKED"; retryAfterSeconds: number }
  | { status: "NOT_ALLOWED" }
  | { status: "NOT_SANDBOX" }
  | { status: "LIMIT" };

/**
 * שומר אמצעי תשלום מדומה למשתמש מחובר, אחרי אימות בעלות באמצעות סיסמת האתר (מוגבל בניסיונות, כמו הגדרת קוד טלפוני).
 * זמין רק כשהספק הפעיל הוא Mock בסביבת sandbox. אין קליטה של פרטי כרטיס כלשהם: הטוקן מונפק ע"י ה-Mock.
 */
export async function addMockCard(params: {
  userId: string;
  currentPassword: string;
  provider: PaymentProvider;
  db?: PrismaClient;
  now?: Date;
}): Promise<AddMockCardResult> {
  const { userId, currentPassword, provider, db = defaultDb, now = new Date() } = params;
  if (!(provider instanceof MockPaymentProvider) || provider.environment !== "sandbox") return { status: "NOT_SANDBOX" };

  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, passwordHash: true, mustChangePassword: true } });
  if (!user || user.role !== "CLIENT" || user.mustChangePassword) return { status: "NOT_ALLOWED" };

  const reservation = await reserveAttempt(db, { scope: "CARD", subject: userId, policy: IVR_PIN_POLICY.setup, now });
  if (!reservation.allowed) return { status: "BLOCKED", retryAfterSeconds: reservation.retryAfterSeconds };
  if (typeof currentPassword !== "string" || !currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
    if (reservation.blockedNow) return { status: "BLOCKED", retryAfterSeconds: IVR_PIN_POLICY.setup.blockMinutes * 60 };
    return { status: "INVALID_PASSWORD", attemptsLeft: reservation.attemptsLeft };
  }
  await recordSuccess(db, "CARD", userId);

  if ((await db.paymentMethod.count({ where: { userId, active: true } })) >= MAX_ACTIVE_METHODS) return { status: "LIMIT" };

  const saved = await provider.issueSandboxToken();
  const row = await db.paymentMethod.create({
    data: {
      userId,
      provider: provider.name,
      environment: environmentOf(provider),
      token: saved.token,
      last4: saved.last4 ?? null,
      brand: saved.brand ?? null,
      expiry: saved.expiry ?? null,
    },
  });
  return { status: "OK", method: toView(row) };
}

/** הסרת אמצעי תשלום של המשתמש עצמו. מושבת ולא נמחק (שומר על קישור היסטורי מתשלומים). Mock: גם מבטל את הטוקן */
export async function removePaymentMethod(params: { userId: string; methodId: string; provider: PaymentProvider | null; db?: PrismaClient }) {
  const { userId, methodId, provider, db = defaultDb } = params;
  const row = await db.paymentMethod.findFirst({ where: { id: methodId, userId, active: true } });
  if (!row) throw new PaymentFlowError("אמצעי התשלום לא נמצא", "NOT_FOUND");
  await db.paymentMethod.update({ where: { id: row.id }, data: { active: false } });
  if (provider instanceof MockPaymentProvider && row.provider === provider.name) await provider.declineToken(row.token);
}

export interface UsableCard {
  id: string;
  token: string;
  last4: string | null;
}

/**
 * אמצעי תשלום שמור שניתן לחייב כעת, או null. רישום PaymentMethod במסד אינו מספיק: נדרש שהשורה פעילה, שייכת לספק
 * ולסביבה הנוכחיים (SANDBOX לא נטען מול ספק אחר ולהפך), ושהספק עצמו מאשר שהטוקן שמיש. ספק שאינו יודע לאמת נחשב כ"לא שמיש".
 */
export async function findUsableCard(userId: string, provider: PaymentProvider, db: PrismaClient = defaultDb): Promise<UsableCard | null> {
  if (!provider.isPaymentMethodUsable) return null;
  const rows = await db.paymentMethod.findMany({
    where: { userId, active: true, provider: provider.name, environment: environmentOf(provider) },
    orderBy: { createdAt: "desc" },
  });
  for (const row of rows) {
    if (await provider.isPaymentMethodUsable(row.token)) return { id: row.id, token: row.token, last4: row.last4 };
  }
  return null;
}
