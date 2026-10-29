import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { IVR_PIN_POLICY, isValidPinFormat, type IvrPinPolicy } from "@/lib/ivr-pin/policy";
import { globalRetryAfter, recordGlobalFailure, recordSuccess, reserveAttempt } from "@/lib/ivr-pin/throttle";

/**
 * שירות הקוד הטלפוני האחיד (4 ספרות). המקום היחיד שבו קוד טלפוני נבדק או נקבע. נפרד לחלוטין מסיסמת האתר:
 * נשמר רק ב-User.ivrPinHash (bcrypt), ולעולם לא נקרא מ-passwordHash. אין שום מסלול שמחזיר את הקוד או את ה-hash.
 *
 * כל פעולת IVR עתידית שדורשת קוד חייבת לעבור דרך verifyIvrPin. השירות לא מחובר כרגע לאישור הזמנה או לתשלום.
 */

interface Deps {
  db?: PrismaClient;
  policy?: IvrPinPolicy;
  now?: Date;
}

// ───────────────────────────── אימות ─────────────────────────────

export type PinVerifyResult =
  | { status: "OK" }
  /** הקוד שגוי. attemptsLeft = כמה ניסיונות נותרו לפני חסימה */
  | { status: "INVALID"; attemptsLeft: number }
  /** המשתמש חסום זמנית (גם אחרי שיחה חדשה או הפעלה מחדש של השרת) */
  | { status: "BLOCKED"; retryAfterSeconds: number }
  /** לא הוגדר קוד טלפוני למשתמש הזה (או שהמשתמש לא קיים: בכוונה אותה תוצאה) */
  | { status: "NOT_SET" }
  /** הקלט אינו 4 ספרות. אינו נספר כניסיון, ואין בו מידע על הקוד */
  | { status: "INVALID_FORMAT" }
  /** האימות מושבת זמנית בכל המערכת בגלל גל כשלונות (הגנה מפני ניסיונות המוניים) */
  | { status: "UNAVAILABLE"; retryAfterSeconds: number };

export async function verifyIvrPin(params: { userId: string; pin: string } & Deps): Promise<PinVerifyResult> {
  const { userId, pin, db = defaultDb, policy = IVR_PIN_POLICY, now = new Date() } = params;

  if (!isValidPinFormat(pin)) return { status: "INVALID_FORMAT" };

  const globalBlock = await globalRetryAfter(db, now);
  if (globalBlock !== null) return { status: "UNAVAILABLE", retryAfterSeconds: globalBlock };

  const user = await db.user.findUnique({ where: { id: userId }, select: { ivrPinHash: true } });
  if (!user?.ivrPinHash) return { status: "NOT_SET" };

  // הניסיון נרשם לפני ההשוואה (אטומית, נעול לפי משתמש), ולכן בקשות מקבילות לא יכולות לעקוף את המונה
  const reservation = await reserveAttempt(db, { scope: "VERIFY", subject: userId, policy: policy.verify, now });
  if (!reservation.allowed) return { status: "BLOCKED", retryAfterSeconds: reservation.retryAfterSeconds };

  if (await verifyPassword(pin, user.ivrPinHash)) {
    await recordSuccess(db, "VERIFY", userId);
    return { status: "OK" };
  }

  await recordGlobalFailure(db, policy.global, now);
  if (reservation.blockedNow) {
    await db.ivrPinEvent.create({ data: { userId, kind: "BLOCKED" } });
    return { status: "BLOCKED", retryAfterSeconds: policy.verify.blockMinutes * 60 };
  }
  return { status: "INVALID", attemptsLeft: reservation.attemptsLeft };
}

// ───────────────────────────── הגדרה / שינוי באתר ─────────────────────────────

export type SetPinResult =
  | { status: "OK"; replaced: boolean }
  | { status: "INVALID_PIN" }
  | { status: "PIN_MISMATCH" }
  | { status: "INVALID_PASSWORD"; attemptsLeft: number }
  | { status: "BLOCKED"; retryAfterSeconds: number }
  /** חשבון שאינו רשאי (לא קיים, או שעדיין חייב להחליף סיסמה זמנית) */
  | { status: "NOT_ALLOWED" };

/**
 * קובע או מחליף את הקוד הטלפוני של משתמש מחובר. מחייב אימות מחדש בסיסמת האתר (לא מסתפק בקיום Session), הקלדה כפולה,
 * ומגביל ניסיונות (כולל ניסיונות סיסמה). הקוד נשמר כ-bcrypt בלבד.
 */
export async function setIvrPin(
  params: { userId: string; currentPassword: string; pin: string; pinConfirm: string } & Deps
): Promise<SetPinResult> {
  const { userId, currentPassword, pin, pinConfirm, db = defaultDb, policy = IVR_PIN_POLICY, now = new Date() } = params;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, mustChangePassword: true, ivrPinHash: true },
  });
  if (!user || user.mustChangePassword) return { status: "NOT_ALLOWED" };

  if (!isValidPinFormat(pin) || !isValidPinFormat(pinConfirm)) return { status: "INVALID_PIN" };
  if (pin !== pinConfirm) return { status: "PIN_MISMATCH" };

  const reservation = await reserveAttempt(db, { scope: "SET", subject: userId, policy: policy.setup, now });
  if (!reservation.allowed) return { status: "BLOCKED", retryAfterSeconds: reservation.retryAfterSeconds };

  if (typeof currentPassword !== "string" || !currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
    if (reservation.blockedNow) return { status: "BLOCKED", retryAfterSeconds: policy.setup.blockMinutes * 60 };
    return { status: "INVALID_PASSWORD", attemptsLeft: reservation.attemptsLeft };
  }
  await recordSuccess(db, "SET", userId);

  const replaced = !!user.ivrPinHash;
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { ivrPinHash: await hashPassword(pin), ivrPinUpdatedAt: now } }),
    db.ivrPinEvent.create({ data: { userId, kind: replaced ? "CHANGED" : "SET", actorId: userId } }),
  ]);
  // קוד חדש שנקבע ע"י הבעלים (שהוכיח את סיסמת האתר) מנקה חסימת אימות קודמת
  await recordSuccess(db, "VERIFY", userId);
  return { status: "OK", replaced };
}

// ───────────────────────────── איפוס עתידי (פנימי בלבד) ─────────────────────────────

/**
 * ממשק שירות פנימי לאיפוס קוד, להכנה לעתיד. אין לו שום נתיב HTTP או IVR: איפוס בטלפון ייבנה רק אחרי שיאושר ערוץ אימות
 * נוסף עצמאי (לא Caller ID ולא ת"ז בלבד). הקורא אחראי לאמת את זהות הפועל לפני הקריאה.
 */
export async function resetIvrPinInternal(params: { userId: string; actorId: string } & Deps) {
  const { userId, actorId, db = defaultDb } = params;
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { ivrPinHash: null, ivrPinUpdatedAt: null } }),
    db.pinThrottle.deleteMany({ where: { subject: userId, scope: { in: ["VERIFY", "SET"] } } }),
    db.ivrPinEvent.create({ data: { userId, kind: "RESET", actorId } }),
  ]);
}

// ───────────────────────────── עזרים ─────────────────────────────

/**
 * hash של סיסמה אקראית שאיש אינו מכיר. משמש חשבון שנוצר בטלפון: שדה passwordHash חובה בסכימה, אבל הקוד הטלפוני
 * לעולם לא נשמר בו, ולכן אי אפשר להשתמש בקוד הטלפוני כסיסמת אתר (גם אם בעתיד יתווסף אימייל לחשבון).
 */
export function unusablePasswordHash() {
  return hashPassword(randomBytes(32).toString("hex"));
}
