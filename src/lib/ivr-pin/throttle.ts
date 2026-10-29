import type { PrismaClient } from "@/generated/prisma/client";
import type { GlobalThrottlePolicy, ThrottlePolicy } from "@/lib/ivr-pin/policy";

/**
 * הגבלת ניסיונות עמידה במסד. כל הפעולות אטומיות: שורת ה-throttle ננעלת (FOR UPDATE) בטרנזקציה קצרה, כך שבקשות
 * מקבילות מסודרות בטור ואי אפשר לעקוף את המונה. אין שום מצב בזיכרון התהליך, והחסימה שורדת הפעלה מחדש.
 *
 * עיקרון ה"הזמנה מראש": ניסיון נספר ברגע שהוא מאושר להתחיל (לפני השוואת הקוד), ומוחזר לאפס רק בהצלחה. כך
 * ניסיונות מקבילים לא יכולים לנחש יותר מ-maxAttempts ניחושים בחלון, גם אם ההשוואה (איטית) עוד לא הסתיימה.
 */

export type Scope = "VERIFY" | "SET" | "CARD" | "SHIFT" | "GLOBAL_VERIFY";

export type Reservation =
  | { allowed: true; attemptsLeft: number; blockedNow: boolean }
  | { allowed: false; retryAfterSeconds: number };

const MINUTE = 60_000;

async function lockRow(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], scope: string, subject: string) {
  await tx.pinThrottle.createMany({ data: [{ scope, subject }], skipDuplicates: true });
  await tx.$queryRaw`SELECT 1 FROM "PinThrottle" WHERE "scope" = ${scope} AND "subject" = ${subject} FOR UPDATE`;
  return tx.pinThrottle.findUniqueOrThrow({ where: { scope_subject: { scope, subject } } });
}

const secondsLeft = (until: Date, now: Date) => Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));

/**
 * מאשר (ורושם) ניסיון אחד עבור (scope, subject). אם יש חסימה פעילה: allowed=false ושום ניסיון לא נרשם.
 * הניסיון ה-maxAttempts-י מפעיל את החסימה מיד (blockedNow), ולכן אחריו אף ניסיון נוסף לא יאושר עד שהחסימה תפוג.
 */
export async function reserveAttempt(
  db: PrismaClient,
  params: { scope: Exclude<Scope, "GLOBAL_VERIFY">; subject: string; policy: ThrottlePolicy; now?: Date }
): Promise<Reservation> {
  const { scope, subject, policy, now = new Date() } = params;
  return db.$transaction(async (tx) => {
    const row = await lockRow(tx, scope, subject);
    if (row.blockedUntil && row.blockedUntil.getTime() > now.getTime()) {
      return { allowed: false as const, retryAfterSeconds: secondsLeft(row.blockedUntil, now) };
    }
    // חסימה שפגה מתחילה חלון חדש
    const count = (row.blockedUntil ? 0 : row.failedCount) + 1;
    const blockedNow = count >= policy.maxAttempts;
    await tx.pinThrottle.update({
      where: { scope_subject: { scope, subject } },
      data: {
        failedCount: count,
        blockedUntil: blockedNow ? new Date(now.getTime() + policy.blockMinutes * MINUTE) : null,
        lastAttemptAt: now,
      },
    });
    return { allowed: true as const, attemptsLeft: Math.max(0, policy.maxAttempts - count), blockedNow };
  });
}

/** אימות מוצלח: מאפס את המונה ומסיר חסימה */
export async function recordSuccess(db: PrismaClient, scope: Exclude<Scope, "GLOBAL_VERIFY">, subject: string) {
  await db.pinThrottle.updateMany({ where: { scope, subject }, data: { failedCount: 0, blockedUntil: null } });
}

/** האם האימות מושבת זמנית בכל המערכת בגלל גל כשלונות (הגנה מפני ניסיונות המוניים) */
export async function globalRetryAfter(db: PrismaClient, now: Date = new Date()): Promise<number | null> {
  const row = await db.pinThrottle.findUnique({ where: { scope_subject: { scope: "GLOBAL_VERIFY", subject: "*" } } });
  if (row?.blockedUntil && row.blockedUntil.getTime() > now.getTime()) return secondsLeft(row.blockedUntil, now);
  return null;
}

/** רושם כשלון אימות אחד בספירה הכללית. חלון קבוע; מעבר לסף מפעיל השבתה זמנית */
export async function recordGlobalFailure(db: PrismaClient, policy: GlobalThrottlePolicy, now: Date = new Date()) {
  await db.$transaction(async (tx) => {
    const row = await lockRow(tx, "GLOBAL_VERIFY", "*");
    const windowMs = policy.windowMinutes * MINUTE;
    const fresh = !row.windowStart || now.getTime() - row.windowStart.getTime() >= windowMs;
    const count = fresh ? 1 : row.failedCount + 1;
    await tx.pinThrottle.update({
      where: { scope_subject: { scope: "GLOBAL_VERIFY", subject: "*" } },
      data: {
        failedCount: count,
        windowStart: fresh ? now : row.windowStart,
        lastAttemptAt: now,
        blockedUntil: count >= policy.maxFailuresPerWindow ? new Date(now.getTime() + policy.blockMinutes * MINUTE) : row.blockedUntil,
      },
    });
  });
}
