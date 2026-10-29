import { prisma } from "@/lib/prisma";
import { allocatePackageMinutes, type PackageBalance } from "@/lib/payments/pricing";
import { creditExpiry } from "@/lib/payments/policy";
import { PaymentFlowError, type Tx } from "@/lib/payments/shared";

/**
 * יתרות דקות: חבילות שעות וזיכויים. ניצול לפי דקות, המקור שפוקע ראשון מנוצל ראשון (חבילות וזיכויים יחד).
 * כל הפונקציות שכותבות (consumeBalance, restoreAppointmentBalance) מניחות שהקורא כבר נעל את יתרות הלקוח
 * עם lockUserBalances בתוך אותה טרנזקציה, ולכן הקריאה והעדכון אטומיים.
 */

export interface BalanceSource {
  kind: "package" | "credit";
  id: string;
  expiresAt: Date;
  minutesRemaining: number;
}

const refOf = (s: Pick<BalanceSource, "kind" | "id">) => `${s.kind}:${s.id}`;

export const toPackageBalance = (s: BalanceSource): PackageBalance => ({
  id: refOf(s),
  expiresAt: s.expiresAt,
  minutesRemaining: s.minutesRemaining,
});

/** מקורות שניתן לנצל כעת: לא פגו ויש בהם יתרה. שאילתת קריאה בלבד; לשינוי יש לנעול קודם */
export async function loadUsableBalances(db: Tx | typeof prisma, userId: string, now: Date): Promise<BalanceSource[]> {
  const [packages, credits] = await Promise.all([
    db.hoursPackage.findMany({ where: { userId, expiresAt: { gt: now }, minutesRemaining: { gt: 0 }, cancelledAt: null } }),
    db.credit.findMany({ where: { userId, expiresAt: { gt: now }, minutesRemaining: { gt: 0 } } }),
  ]);
  return [
    ...packages.map((p) => ({ kind: "package" as const, id: p.id, expiresAt: p.expiresAt, minutesRemaining: p.minutesRemaining })),
    ...credits.map((c) => ({ kind: "credit" as const, id: c.id, expiresAt: c.expiresAt, minutesRemaining: c.minutesRemaining })),
  ];
}

export type ConsumeResult = { ok: true; consumedMinutes: number } | { ok: false; shortfallMinutes: number };

/**
 * מנכה בדיוק `minutes` דקות מהיתרות (הפוקע ראשון קודם) ורושם תנועת CONSUME לכל מקור, מקושרת להזמנה.
 * אם היתרה אינה מספיקה לא משנה כלום ומחזיר ok:false (בלי יתרה שלילית ובלי ניכוי חלקי).
 */
export async function consumeBalance(
  tx: Tx,
  params: { userId: string; appointmentId: string; minutes: number; now: Date }
): Promise<ConsumeResult> {
  const { userId, appointmentId, minutes, now } = params;
  const sources = await loadUsableBalances(tx, userId, now);
  const { allocations, shortfallMinutes } = allocatePackageMinutes(sources.map(toPackageBalance), minutes, now);
  if (shortfallMinutes > 0) return { ok: false, shortfallMinutes };

  for (const a of allocations) {
    const [kind, id] = a.packageId.split(":") as ["package" | "credit", string];
    if (kind === "package") {
      // התנאי minutesRemaining >= minutes הוא רשת ביטחון נוספת מעבר לנעילה ולאילוץ ה-CHECK במסד
      const { count } = await tx.hoursPackage.updateMany({
        where: { id, userId, minutesRemaining: { gte: a.minutes } },
        data: { minutesRemaining: { decrement: a.minutes } },
      });
      if (count !== 1) throw new PaymentFlowError("היתרה השתנתה, נסו שוב", "CONFLICT");
      await tx.packageUsage.create({ data: { packageId: id, kind: "CONSUME", minutes: a.minutes, appointmentId } });
    } else {
      const { count } = await tx.credit.updateMany({
        where: { id, userId, minutesRemaining: { gte: a.minutes } },
        data: { minutesRemaining: { decrement: a.minutes } },
      });
      if (count !== 1) throw new PaymentFlowError("היתרה השתנתה, נסו שוב", "CONFLICT");
      await tx.creditUsage.create({ data: { creditId: id, kind: "CONSUME", minutes: a.minutes, appointmentId } });
    }
  }
  return { ok: true, consumedMinutes: minutes };
}

export interface RestoreResult {
  /** דקות שחזרו למקור שעדיין בתוקף */
  restoredMinutes: number;
  /** דקות שהפכו לזיכוי חדש (המקור פג) */
  creditedMinutes: number;
  creditId?: string;
}

/**
 * מחזיר את הדקות שנוצלו עבור הזמנה שבוטלה. אידמפוטנטי: מחשב את היתרה נטו (ניצול פחות החזרות קודמות) לכל מקור,
 * ולכן קריאה שנייה לא מחזירה כלום.
 *  - מקור שעדיין בתוקף: הדקות חוזרות אליו.
 *  - מקור שפג: נוצר זיכוי חדש בתוקף 30 יום מרגע הביטול. תוקף המקור המקורי אינו מוארך.
 * מניח שיתרות הלקוח נעולות (lockUserBalances).
 */
export async function restoreAppointmentBalance(
  tx: Tx,
  params: { userId: string; appointmentId: string; now: Date }
): Promise<RestoreResult> {
  const { userId, appointmentId, now } = params;
  const [pkgRows, creditRows] = await Promise.all([
    tx.packageUsage.findMany({ where: { appointmentId } }),
    tx.creditUsage.findMany({ where: { appointmentId } }),
  ]);

  const net = (rows: { kind: string; minutes: number }[]) =>
    rows.reduce((sum, r) => sum + (r.kind === "CONSUME" ? r.minutes : -r.minutes), 0);
  const group = <T extends { kind: string; minutes: number }>(rows: T[], key: (r: T) => string) => {
    const map = new Map<string, T[]>();
    for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
    return map;
  };

  type Pending = { kind: "package" | "credit"; id: string; minutes: number; expired: boolean };
  const pending: Pending[] = [];

  for (const [packageId, rows] of group(pkgRows, (r) => r.packageId)) {
    const minutes = net(rows);
    if (minutes <= 0) continue;
    const source = await tx.hoursPackage.findFirst({ where: { id: packageId, userId } });
    if (!source) continue;
    // חבילה שבוטלה ע"י מנהל נחשבת כפגה: דקות שיוחזרו אליה הופכות לזיכוי, ולא פותחות מחדש יתרה שהוחזרה/אופסה
    pending.push({ kind: "package", id: packageId, minutes, expired: source.expiresAt.getTime() <= now.getTime() || source.cancelledAt !== null });
  }
  for (const [creditId, rows] of group(creditRows, (r) => r.creditId)) {
    const minutes = net(rows);
    if (minutes <= 0) continue;
    const source = await tx.credit.findFirst({ where: { id: creditId, userId } });
    if (!source) continue;
    pending.push({ kind: "credit", id: creditId, minutes, expired: source.expiresAt.getTime() <= now.getTime() });
  }

  const expiredTotal = pending.filter((p) => p.expired).reduce((n, p) => n + p.minutes, 0);
  let creditId: string | undefined;
  if (expiredTotal > 0) {
    const credit = await tx.credit.create({
      data: {
        userId,
        minutesTotal: expiredTotal,
        minutesRemaining: expiredTotal,
        expiresAt: creditExpiry(now),
        reason: "restored_from_expired_balance",
        sourceAppointmentId: appointmentId,
      },
    });
    creditId = credit.id;
  }

  let restoredMinutes = 0;
  for (const p of pending) {
    const convertedToCreditId = p.expired ? creditId : undefined;
    if (!p.expired) {
      if (p.kind === "package") {
        await tx.hoursPackage.update({ where: { id: p.id }, data: { minutesRemaining: { increment: p.minutes } } });
      } else {
        await tx.credit.update({ where: { id: p.id }, data: { minutesRemaining: { increment: p.minutes } } });
      }
      restoredMinutes += p.minutes;
    }
    if (p.kind === "package") {
      await tx.packageUsage.create({
        data: { packageId: p.id, kind: "RESTORE", minutes: p.minutes, appointmentId, convertedToCreditId },
      });
    } else {
      await tx.creditUsage.create({
        data: { creditId: p.id, kind: "RESTORE", minutes: p.minutes, appointmentId, convertedToCreditId },
      });
    }
  }
  return { restoredMinutes, creditedMinutes: expiredTotal, creditId };
}
