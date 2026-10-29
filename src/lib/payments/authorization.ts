import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { IVR_PIN_POLICY, type IvrPinPolicy } from "@/lib/ivr-pin/policy";
import { verifyIvrPin, type PinVerifyResult } from "@/lib/ivr-pin/service";

/**
 * הרשאה חד-פעמית לפעולה כספית אחת. מונפקת רק אחרי אימות קוד טלפוני מוצלח (verifyIvrPin), קשורה למשתמש, להזמנה,
 * לפעולה ולחלוקת התשלום המדויקת שהוצגה למתקשר, תקפה שניות ספורות, ונצרכת אטומית. הכול במסד ולא בזיכרון שיחה:
 * מזהה ההרשאה הוא רק מצביע, וההוכחה היא השורה הנעולה במסד.
 */

export type AuthorizedAction = "CONFIRM_BALANCE" | "PAY_CARD";

export interface AuthorizationBinding {
  userId: string;
  appointmentId: string;
  action: AuthorizedAction;
  /** החלק בכסף שהוצג ללקוח ואושר (אגורות). 0 באישור מיתרה */
  amountAgorot: number;
  /** הדקות שיינוכו מהיתרה שהוצגו ללקוח ואושרו */
  packageMinutes: number;
}

export type AuthorizeResult =
  | { status: "OK"; authorizationId: string }
  /** ההחזקה אינה פעילה (פגה/בוטלה/אושרה) או אינה של המשתמש: לא נבדק קוד ולא נרשם ניסיון */
  | { status: "HOLD_INACTIVE" }
  | Exclude<PinVerifyResult, { status: "OK" }>;

interface Deps {
  db?: PrismaClient;
  policy?: IvrPinPolicy;
  now?: Date;
}

function assertBindingShape(b: AuthorizationBinding) {
  const ok =
    Number.isInteger(b.amountAgorot) && Number.isInteger(b.packageMinutes) && b.amountAgorot >= 0 && b.packageMinutes >= 0 &&
    (b.action === "CONFIRM_BALANCE" ? b.amountAgorot === 0 && b.packageMinutes > 0 : b.amountAgorot > 0);
  if (!ok) throw new RangeError("invalid authorization binding");
}

/**
 * מאמת קוד טלפוני ומנפיק הרשאה לפעולה הכספית המתוארת. נכשל בלי להנפיק דבר אם הקוד שגוי/חסום/לא מוגדר.
 * הקורא חייב להעביר את הקוד רק אם הגיע בגוף POST (ראו payment-flow). הקוד לא נשמר ולא נרשם.
 */
export async function authorizeWithPin(params: AuthorizationBinding & { pin: string } & Deps): Promise<AuthorizeResult> {
  const { pin, db = defaultDb, policy = IVR_PIN_POLICY, now = new Date(), ...binding } = params;
  assertBindingShape(binding);

  const appt = await db.appointment.findUnique({
    where: { id: binding.appointmentId },
    select: { userId: true, status: true, holdExpiresAt: true },
  });
  const holdActive = !!appt && appt.userId === binding.userId && appt.status === "PENDING_PAYMENT" && !!appt.holdExpiresAt && appt.holdExpiresAt.getTime() > now.getTime();
  if (!holdActive) return { status: "HOLD_INACTIVE" };

  const verified = await verifyIvrPin({ userId: binding.userId, pin, db, policy, now });
  if (verified.status !== "OK") return verified;

  const id = randomBytes(16).toString("hex");
  await db.$transaction([
    // הרשאה קודמת שלא נוצלה לאותה הזמנה מבוטלת: רק האחרונה תקפה
    db.paymentAuthorization.updateMany({
      where: { userId: binding.userId, appointmentId: binding.appointmentId, consumedAt: null },
      data: { consumedAt: now },
    }),
    db.paymentAuthorization.create({
      data: { id, ...binding, expiresAt: new Date(now.getTime() + policy.authorization.ttlSeconds * 1000) },
    }),
  ]);
  return { status: "OK", authorizationId: id };
}

export interface ConsumedAuthorization {
  action: AuthorizedAction;
  amountAgorot: number;
  packageMinutes: number;
}

/**
 * צורך הרשאה אטומית (UPDATE ... RETURNING): מצליח פעם אחת בלבד, ורק למשתמש ולהזמנה שהוקשרו אליה, ורק לפני פקיעה.
 * כל התאמה חסרה מחזירה null ואינה צורכת את ההרשאה.
 */
export async function consumeAuthorization(
  params: { id: string; userId: string; appointmentId: string } & Pick<Deps, "db" | "now">
): Promise<ConsumedAuthorization | null> {
  const { id, userId, appointmentId, db = defaultDb, now = new Date() } = params;
  const rows = await db.$queryRaw<ConsumedAuthorization[]>`
    UPDATE "PaymentAuthorization" SET "consumedAt" = ${now}
    WHERE "id" = ${id} AND "userId" = ${userId} AND "appointmentId" = ${appointmentId}
      AND "consumedAt" IS NULL AND "expiresAt" > ${now}
    RETURNING "action"::text AS "action", "amountAgorot", "packageMinutes"`;
  return rows[0] ?? null;
}
