import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { IVR_PIN_POLICY } from "@/lib/ivr-pin/policy";
import { recordSuccess, reserveAttempt } from "@/lib/ivr-pin/throttle";
import { ShiftError } from "@/lib/shifts/errors";

/**
 * אימות מחדש בסיסמת האתר לפני התחייבות כספית חוזרת (יצירת משמרת = חיוב חודשי קבוע בכרטיס שמור). לא מסתפקים בקיום
 * Session. מוגבל בניסיונות באותה מדיניות כמו שאר הפעולות הרגישות (5 ניסיונות, חסימה ל-15 דקות), בטבלת ההגבלה במסד.
 */
export async function reauthenticateForShift(params: { userId: string; password: unknown; now?: Date; db?: PrismaClient }) {
  const { userId, password, now = new Date(), db = defaultDb } = params;
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true, mustChangePassword: true } });
  if (!user || user.mustChangePassword) throw new ShiftError("לא ניתן לבצע פעולה זו בחשבון הנוכחי", "FORBIDDEN");

  const reservation = await reserveAttempt(db, { scope: "SHIFT", subject: userId, policy: IVR_PIN_POLICY.setup, now });
  if (!reservation.allowed) throw new ShiftError("בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר", "BLOCKED", { retryAfterSeconds: reservation.retryAfterSeconds });
  if (typeof password !== "string" || !password || !(await verifyPassword(password, user.passwordHash))) {
    if (reservation.blockedNow) {
      throw new ShiftError("בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר", "BLOCKED", { retryAfterSeconds: IVR_PIN_POLICY.setup.blockMinutes * 60 });
    }
    throw new ShiftError("הסיסמה שגויה", "INVALID_PASSWORD", { attemptsLeft: reservation.attemptsLeft });
  }
  await recordSuccess(db, "SHIFT", userId);
}
