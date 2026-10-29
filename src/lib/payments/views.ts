import { prisma } from "@/lib/prisma";
import { quoteHold } from "@/lib/payments/booking-payment";
import { loadUsableBalances } from "@/lib/payments/balances";
import { regularPriceAgorot } from "@/lib/payments/pricing";
import { PaymentFlowError } from "@/lib/payments/shared";

/**
 * נתונים לממשק המשתמש. כל החישובים (יתרה, תוקף, מחיר, פקיעת החזקה) נעשים כאן בשרת; הדפדפן רק מציג.
 * כל פונקציה מחזירה אך ורק נתונים של המשתמש שהועבר אליה.
 */

// ───────────────────────────── יתרות ─────────────────────────────

export interface CancellationRequestView {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  decidedAt: string | null;
}

export interface PackageView {
  id: string;
  hours: number;
  minutesTotal: number;
  minutesRemaining: number;
  pricePaidAgorot: number;
  purchasedAt: string;
  expiresAt: string;
  /** הבקשה האחרונה לביטול החבילה, אם קיימת */
  cancellationRequest: CancellationRequestView | null;
}

export interface CreditView {
  id: string;
  minutesTotal: number;
  minutesRemaining: number;
  createdAt: string;
  expiresAt: string;
}

export interface BalanceView {
  serverNow: string;
  /** סך הדקות הזמינות כעת (חבילות וזיכויים בתוקף), כפי שחושב בשרת */
  totalMinutes: number;
  packages: PackageView[];
  /** חבילות בתוקף שנוצלו במלואן */
  exhaustedPackages: PackageView[];
  /** חבילות שפג תוקפן: לא נכללות ביתרה הזמינה */
  expiredPackages: PackageView[];
  credits: CreditView[];
  expiredCredits: CreditView[];
}

export async function getBalanceView(userId: string, now: Date = new Date()): Promise<BalanceView> {
  const [packages, credits] = await Promise.all([
    prisma.hoursPackage.findMany({
      where: { userId },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 200,
      include: { cancellationRequests: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    prisma.credit.findMany({ where: { userId }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: 200 }),
  ]);

  const toPackage = (p: (typeof packages)[number]): PackageView => {
    const req = p.cancellationRequests[0];
    return {
      id: p.id,
      hours: p.hours,
      minutesTotal: p.minutesTotal,
      minutesRemaining: p.minutesRemaining,
      pricePaidAgorot: p.pricePaidAgorot,
      purchasedAt: p.purchasedAt.toISOString(),
      expiresAt: p.expiresAt.toISOString(),
      cancellationRequest: req
        ? { id: req.id, status: req.status, createdAt: req.createdAt.toISOString(), decidedAt: req.decidedAt?.toISOString() ?? null }
        : null,
    };
  };
  const toCredit = (c: (typeof credits)[number]): CreditView => ({
    id: c.id,
    minutesTotal: c.minutesTotal,
    minutesRemaining: c.minutesRemaining,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
  });

  const live = (expiresAt: Date) => expiresAt.getTime() > now.getTime();
  const activePackages = packages.filter((p) => live(p.expiresAt) && p.minutesRemaining > 0);
  const activeCredits = credits.filter((c) => live(c.expiresAt) && c.minutesRemaining > 0);

  return {
    serverNow: now.toISOString(),
    totalMinutes:
      activePackages.reduce((n, p) => n + p.minutesRemaining, 0) + activeCredits.reduce((n, c) => n + c.minutesRemaining, 0),
    packages: activePackages.map(toPackage),
    exhaustedPackages: packages.filter((p) => live(p.expiresAt) && p.minutesRemaining === 0).map(toPackage),
    expiredPackages: packages.filter((p) => !live(p.expiresAt)).map(toPackage),
    credits: activeCredits.map(toCredit),
    expiredCredits: credits.filter((c) => !live(c.expiresAt)).map(toCredit),
  };
}

// ───────────────────────────── פרטי החזקה ─────────────────────────────

export interface HoldDetails {
  appointmentId: string;
  status: "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED";
  paymentStatus: string;
  room: { key: string; name: string };
  startTime: string;
  endTime: string;
  durationMinutes: number;
  /** זמן השרת ברגע התשובה. הדפדפן מחשב ממנו את ההפרש בלבד, לצורך תצוגה */
  serverNow: string;
  /** מועד פקיעת ההחזקה כפי שנקבע בשרת (רק בהחזקה פעילה) */
  holdExpiresAt: string | null;
  holdActive: boolean;
  fullPriceAgorot: number;
  availableBalanceMinutes: number;
  /** חלוקת התשלום עם שימוש ביתרה (רק בהחזקה פעילה) */
  plan: { packageMinutes: number; cashAgorot: number; fullyCoveredByBalance: boolean } | null;
  paidFromBalanceMinutes: number;
  paidCashAgorot: number;
  /** ניסיון התשלום האחרון בכסף, אם היה */
  payment: {
    id: string;
    /** מזהה אצל הספק; משמש רק את פאנל התשלום המדומה בסביבת פיתוח */
    providerPaymentId: string | null;
    status: string;
    amountAgorot: number;
    packageMinutes: number;
    refundedAgorot: number;
  } | null;
}

export async function getHoldDetails(appointmentId: string, userId: string, now: Date = new Date()): Promise<HoldDetails> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { room: true } });
  // מסתירים קיום הזמנה של אחרים
  if (!appt || appt.userId !== userId) throw new PaymentFlowError("ההזמנה לא נמצאה", "NOT_FOUND");

  const durationMinutes = (appt.endTime.getTime() - appt.startTime.getTime()) / 60_000;
  const holdActive = appt.status === "PENDING_PAYMENT" && !!appt.holdExpiresAt && appt.holdExpiresAt.getTime() > now.getTime();

  let fullPriceAgorot = 0;
  try {
    fullPriceAgorot = regularPriceAgorot(durationMinutes);
  } catch {
    // משך שאינו ניתן לתמחור: נשאר 0 והתשלום יידחה בשרת
  }

  const [sources, payment] = await Promise.all([
    loadUsableBalances(prisma, userId, now),
    prisma.payment.findFirst({
      where: { appointmentId, purpose: "BOOKING" },
      orderBy: { createdAt: "desc" },
      include: { refunds: { where: { status: "SUCCEEDED" } } },
    }),
  ]);

  let plan: HoldDetails["plan"] = null;
  if (holdActive) {
    const q = await quoteHold({ appointmentId, userId, now });
    plan = { packageMinutes: q.packageMinutes, cashAgorot: q.cashAgorot, fullyCoveredByBalance: q.fullyCoveredByBalance };
  }

  return {
    appointmentId,
    status: appt.status,
    paymentStatus: appt.paymentStatus,
    room: { key: appt.room.key, name: appt.room.name },
    startTime: appt.startTime.toISOString(),
    endTime: appt.endTime.toISOString(),
    durationMinutes,
    serverNow: now.toISOString(),
    holdExpiresAt: holdActive ? appt.holdExpiresAt!.toISOString() : null,
    holdActive,
    fullPriceAgorot,
    availableBalanceMinutes: sources.reduce((n, s) => n + s.minutesRemaining, 0),
    plan,
    paidFromBalanceMinutes: appt.paidFromBalanceMinutes,
    paidCashAgorot: appt.paidCashAgorot,
    payment: payment
      ? {
          id: payment.id,
          providerPaymentId: payment.providerPaymentId,
          status: payment.status,
          amountAgorot: payment.amountAgorot,
          packageMinutes: payment.packageMinutes,
          refundedAgorot: payment.refunds.reduce((n, r) => n + r.amountAgorot, 0),
        }
      : null,
  };
}

// ───────────────────────────── היסטוריה ─────────────────────────────

export type HistoryKind =
  | "PACKAGE_PURCHASE"
  | "BOOKING_PAYMENT"
  | "MINUTES_USED"
  | "MINUTES_RESTORED"
  | "CREDIT_GRANTED"
  | "REFUND";

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  at: string;
  status?: string;
  amountAgorot?: number;
  minutes?: number;
  hours?: number;
  roomName?: string;
  startTime?: string;
  expiresAt?: string;
  /** החזרת דקות שהומרה לזיכוי כי החבילה המקורית פגה */
  convertedToCredit?: boolean;
  /** קוד סיבה פנימי של החזר (לתרגום בתצוגה) */
  reasonCode?: string;
}

const HISTORY_LIMIT = 200;

/** היסטוריית תשלומים וניצול של המשתמש בלבד: רכישות, תשלומי הזמנה, תנועות דקות, זיכויים והחזרים */
export async function getPaymentHistory(userId: string): Promise<HistoryEntry[]> {
  const [payments, refunds, pkgUsage, creditUsage, credits] = await Promise.all([
    prisma.payment.findMany({
      where: { userId, purpose: { in: ["BOOKING", "PACKAGE"] } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { appointment: { include: { room: { select: { name: true } } } } },
    }),
    prisma.refund.findMany({
      where: { payment: { userId } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { payment: { include: { appointment: { include: { room: { select: { name: true } } } } } } },
    }),
    prisma.packageUsage.findMany({ where: { package: { userId } }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT }),
    prisma.creditUsage.findMany({ where: { credit: { userId } }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT }),
    prisma.credit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT }),
  ]);

  const apptIds = [...new Set([...pkgUsage, ...creditUsage].map((u) => u.appointmentId).filter((x): x is string => !!x))];
  const appts = apptIds.length
    ? await prisma.appointment.findMany({
        where: { id: { in: apptIds }, userId },
        select: { id: true, startTime: true, room: { select: { name: true } } },
      })
    : [];
  const apptById = new Map(appts.map((a) => [a.id, a]));

  const entries: HistoryEntry[] = [];

  for (const p of payments) {
    entries.push({
      id: `pay:${p.id}`,
      kind: p.purpose === "PACKAGE" ? "PACKAGE_PURCHASE" : "BOOKING_PAYMENT",
      at: (p.paidAt ?? p.createdAt).toISOString(),
      status: p.status,
      amountAgorot: p.amountAgorot,
      hours: p.packageHours ?? undefined,
      minutes: p.packageMinutes || undefined,
      roomName: p.appointment?.room.name,
      startTime: p.appointment?.startTime.toISOString(),
    });
  }
  for (const r of refunds) {
    entries.push({
      id: `refund:${r.id}`,
      kind: "REFUND",
      at: r.createdAt.toISOString(),
      status: r.status,
      amountAgorot: r.amountAgorot,
      roomName: r.payment.appointment?.room.name,
      startTime: r.payment.appointment?.startTime.toISOString(),
      reasonCode: r.reason ?? undefined,
    });
  }
  for (const u of [...pkgUsage, ...creditUsage]) {
    const a = u.appointmentId ? apptById.get(u.appointmentId) : undefined;
    entries.push({
      id: `use:${u.id}`,
      kind: u.kind === "CONSUME" ? "MINUTES_USED" : "MINUTES_RESTORED",
      at: u.createdAt.toISOString(),
      minutes: u.minutes,
      roomName: a?.room.name,
      startTime: a?.startTime.toISOString(),
      convertedToCredit: !!u.convertedToCreditId,
    });
  }
  for (const c of credits) {
    entries.push({
      id: `credit:${c.id}`,
      kind: "CREDIT_GRANTED",
      at: c.createdAt.toISOString(),
      minutes: c.minutesTotal,
      expiresAt: c.expiresAt.toISOString(),
    });
  }

  return entries.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
}
