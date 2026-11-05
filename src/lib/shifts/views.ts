import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import type { PaymentProvider } from "@/lib/payments/provider";
import { findUsableCard } from "@/lib/payments/saved-methods";
import { billingDueDates, billingMonths } from "@/lib/shifts/calendar";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";

/** תצוגות משמרות ללקוח ולמנהל. כל החישובים (סכומים, ספירות, מועדים) בשרת; הדפדפן רק מציג. תצוגת לקוח מוגבלת למשתמש עצמו */

export interface ShiftMonthView {
  month: string;
  /** מועד החיוב (YYYY-MM-DD). null במשמרת ישנה שחויבה לפי חודש קלנדרי */
  dueDate: string | null;
  count: number;
  amountAgorot: number;
  /** מצב החיוב באותו חודש, או null אם טרם נוצר חיוב */
  chargeStatus: string | null;
  paidAt: string | null;
  failureCode: string | null;
  graceUntil: string | null;
  /** מזהה שורת החיוב (לתיעוד תשלום ידני ע"י מנהל), אם נוצרה */
  chargeId: string | null;
  manual: { amountAgorot: number; paidOn: string; reference: string | null } | null;
}

export interface ShiftChargeView {
  id: string;
  month: string;
  dueDate: string | null;
  amountAgorot: number;
  occurrenceCount: number;
  status: string;
  attempt: number;
  paidAt: string | null;
  failureCode: string | null;
  graceUntil: string | null;
  refundedAgorot: number;
  note: string | null;
}

export interface ShiftRequestView {
  id: string;
  kind: "CHANGE" | "CANCEL";
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  proposedRoomKey: string | null;
  proposedWeekday: number | null;
  proposedWindowId: string | null;
  requestedFrom: string | null;
  appliedFrom: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * מצב שעה חלופית: PENDING_GRANT = הזכאות נרשמה והזיכוי יינתן כשהמשמרת פעילה; OPEN = יתרה זמינה; USED = נוצלה במלואה;
 * EXPIRED = פג תוקף עם יתרה; WAIVED = ויתור מפורש של מנהל.
 */
export type MakeupState = "PENDING_GRANT" | "OPEN" | "USED" | "EXPIRED" | "WAIVED";

export interface MakeupView {
  occurrenceId: string;
  date: string;
  /** משך המפגש שבוטל (דקות): כל מה שמגיע ללקוח */
  minutesTotal: number;
  minutesRemaining: number;
  expiresAt: string | null;
  state: MakeupState;
  note: string | null;
}

export interface CreditInfo {
  minutesTotal: number;
  minutesRemaining: number;
  expiresAt: Date;
}

export function makeupViewOf(o: { id: string; date: string; startTime: Date; endTime: Date; makeupStatus: string | null; makeupNote: string | null; makeupCreditId: string | null }, credits: Map<string, CreditInfo>, now: Date): MakeupView {
  const total = Math.round((o.endTime.getTime() - o.startTime.getTime()) / 60_000);
  const credit = o.makeupCreditId ? credits.get(o.makeupCreditId) : undefined;
  let state: MakeupState;
  if (o.makeupStatus === "WAIVED") state = "WAIVED";
  else if (!credit) state = "PENDING_GRANT";
  else if (credit.minutesRemaining === 0) state = "USED";
  else if (credit.expiresAt.getTime() <= now.getTime()) state = "EXPIRED";
  else state = "OPEN";
  return {
    occurrenceId: o.id,
    date: o.date,
    minutesTotal: total,
    minutesRemaining: state === "OPEN" ? credit!.minutesRemaining : state === "PENDING_GRANT" ? total : 0,
    expiresAt: credit?.expiresAt.toISOString() ?? null,
    state,
    note: o.makeupNote,
  };
}

export async function loadMakeupCredits(db: Pick<PrismaClient, "credit">, shifts: { occurrences: { makeupCreditId: string | null }[] }[]): Promise<Map<string, CreditInfo>> {
  const ids = shifts.flatMap((s) => s.occurrences.map((o) => o.makeupCreditId)).filter((x): x is string => !!x);
  if (ids.length === 0) return new Map();
  const rows = await db.credit.findMany({ where: { id: { in: ids } }, select: { id: true, minutesTotal: true, minutesRemaining: true, expiresAt: true } });
  return new Map(rows.map((r) => [r.id, { minutesTotal: r.minutesTotal, minutesRemaining: r.minutesRemaining, expiresAt: r.expiresAt }]));
}

export interface ShiftView {
  id: string;
  room: { key: string; name: string };
  weekday: number;
  windowId: string;
  startDate: string;
  endDate: string;
  status: string;
  suspensionReason: string | null;
  occurrencePriceAgorot: number;
  /** המחיר החודשי של המשבצת בעת ההזמנה. 0 = משמרת ישנה שתומחרה לפי מופע */
  monthlyPriceAgorot: number;
  /** סך שלושת החיובים (המחיר החודשי × 3). 0 במשמרת ישנה */
  totalAgorot: number;
  /** AUTO = חיוב אוטומטי באמצעי תשלום שמור; MANUAL = תשלום ידני בתיאום מנהל */
  paymentMode: "AUTO" | "MANUAL";
  /** זכאויות לשעה חלופית שעוד לא תואמו (סגירה ביוזמת ההנהלה) */
  /** שעות חלופיות שעדיין ניתנות למימוש (יתרה בתוקף) או שטרם ניתן להן זיכוי */
  makeupOwed: number;
  /** סך דקות היתרה הזמינה בשעות חלופיות */
  makeupMinutesRemaining: number;
  makeups: MakeupView[];
  /** האם המשמרת ניתנת לשימוש כעת (פעילה בלבד). מושעית: המשבצות שמורות אך אין שימוש עד החלטת מנהל */
  usable: boolean;
  counts: { total: number; scheduled: number; skipped: number; cancelled: number };
  upcoming: { date: string; startTime: string; endTime: string }[];
  months: ShiftMonthView[];
  charges: ShiftChargeView[];
  /** החודש הבא שיחויב, אם יש */
  nextCharge: { month: string; dueDate: string | null; amountAgorot: number } | null;
  requests: ShiftRequestView[];
  openRequest: ShiftRequestView | null;
}

type ShiftWithAll = Prisma.ShiftGetPayload<{ include: { room: true; occurrences: true; charges: true; requests: true } }>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toRequestView(r: ShiftWithAll["requests"][number]): ShiftRequestView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    proposedRoomKey: r.proposedRoomKey,
    proposedWeekday: r.proposedWeekday,
    proposedWindowId: r.proposedWindowId,
    requestedFrom: r.requestedFrom,
    appliedFrom: r.appliedFrom,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
    decidedAt: iso(r.decidedAt),
  };
}

export function toShiftView(shift: ShiftWithAll, now: Date, credits: Map<string, CreditInfo> = new Map()): ShiftView {
  const scheduled = shift.occurrences.filter((o) => o.status === "SCHEDULED");
  const requests = [...shift.requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toRequestView);
  const today = jerusalemTodayIso(now);
  const dueDates = billingDueDates(shift.startDate);

  const months: ShiftMonthView[] = billingMonths(shift.startDate).map((month, index) => {
    const occ = scheduled.filter((o) => o.month === month);
    const charge = shift.charges.find((c) => c.month === month);
    return {
      month,
      // החיוב הראשון נקבע בעת ההזמנה (שורת החיוב), והשני והשלישי לפי תאריך ההתחלה
      dueDate: shift.monthlyPriceAgorot > 0 ? charge?.dueDate ?? dueDates[index] : null,
      count: occ.length,
      // משמרת עם מחיר חודשי קבוע: תמיד הסכום הקבוע. משמרת ישנה: סכום המופעים
      amountAgorot: shift.monthlyPriceAgorot > 0 ? shift.monthlyPriceAgorot : occ.reduce((n, o) => n + o.priceAgorot, 0),
      chargeStatus: charge?.status ?? null,
      paidAt: iso(charge?.paidAt ?? null),
      failureCode: charge?.failureCode ?? null,
      graceUntil: iso(charge?.graceUntil ?? null),
      chargeId: charge?.id ?? null,
      manual: charge?.manualPaidOn ? { amountAgorot: charge.manualAmountAgorot ?? charge.amountAgorot, paidOn: charge.manualPaidOn, reference: charge.manualReference } : null,
    };
  });
  // החיוב הבא: הראשון שטרם שולם ושמועדו עוד לא עבר (או הגיע היום)
  const next = shift.status === "ACTIVE" ? months.find((m) => m.chargeStatus !== "PAID" && m.chargeStatus !== "WAIVED" && (m.dueDate ?? `${m.month}-01`) >= today) : undefined;
  const makeups = shift.occurrences
    .filter((o) => o.makeupStatus !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((o) => makeupViewOf(o, credits, now));

  return {
    id: shift.id,
    room: { key: shift.room.key, name: shift.room.name },
    weekday: shift.weekday,
    windowId: shift.windowId,
    startDate: shift.startDate,
    endDate: shift.endDate,
    status: shift.status,
    suspensionReason: shift.suspensionReason,
    occurrencePriceAgorot: shift.occurrencePriceAgorot,
    monthlyPriceAgorot: shift.monthlyPriceAgorot,
    totalAgorot: shift.monthlyPriceAgorot * 3,
    paymentMode: shift.paymentMode,
    makeupOwed: makeups.filter((m) => m.state === "OPEN" || m.state === "PENDING_GRANT").length,
    makeupMinutesRemaining: makeups.filter((m) => m.state === "OPEN").reduce((n, m) => n + m.minutesRemaining, 0),
    makeups,
    usable: shift.status === "ACTIVE",
    counts: {
      total: shift.occurrences.length,
      scheduled: scheduled.length,
      skipped: shift.occurrences.filter((o) => o.status === "SKIPPED_CLOSED_DAY").length,
      cancelled: shift.occurrences.filter((o) => o.status === "CANCELLED").length,
    },
    upcoming: scheduled
      .filter((o) => o.endTime.getTime() > now.getTime())
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
      .slice(0, 6)
      .map((o) => ({ date: o.date, startTime: o.startTime.toISOString(), endTime: o.endTime.toISOString() })),
    months,
    charges: [...shift.charges]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((c) => ({
        id: c.id,
        month: c.month,
        dueDate: c.dueDate,
        amountAgorot: c.amountAgorot,
        occurrenceCount: c.occurrenceCount,
        status: c.status,
        attempt: c.attempt,
        paidAt: iso(c.paidAt),
        failureCode: c.failureCode,
        graceUntil: iso(c.graceUntil),
        refundedAgorot: c.refundedAgorot,
        note: c.note,
      })),
    nextCharge: next ? { month: next.month, dueDate: next.dueDate, amountAgorot: next.amountAgorot } : null,
    requests,
    openRequest: requests.find((r) => r.status === "PENDING") ?? null,
  };
}

const include = { room: true, occurrences: true, charges: true, requests: true } satisfies Prisma.ShiftInclude;

export interface MyShiftsView {
  serverNow: string;
  /** זכאות להזמנת משמרת חדשה: אישור מנהל + חשבון מאושר. נבדקת שוב בשרת בכל יצירה */
  eligible: boolean;
  hasUsableCard: boolean;
  shifts: ShiftView[];
}

export async function getMyShifts(params: { userId: string; provider: PaymentProvider | null; now?: Date; db?: PrismaClient }): Promise<MyShiftsView> {
  const { userId, provider, now = new Date(), db = defaultDb } = params;
  const [user, shifts] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { canBookShifts: true, status: true, role: true } }),
    db.shift.findMany({ where: { userId }, include, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const card = provider ? await findUsableCard(userId, provider, db) : null;
  const credits = await loadMakeupCredits(db, shifts);
  return {
    serverNow: now.toISOString(),
    eligible: !!user && user.role === "CLIENT" && user.status === "APPROVED" && user.canBookShifts,
    hasUsableCard: !!card,
    shifts: shifts.map((s) => toShiftView(s, now, credits)),
  };
}

// ───────────────────────────── מנהל ─────────────────────────────

export interface AdminShiftRow {
  id: string;
  user: { id: string; name: string; email: string | null; phone: string | null };
  room: { key: string; name: string };
  weekday: number;
  windowId: string;
  startDate: string;
  endDate: string;
  status: string;
  suspensionReason: string | null;
  scheduled: number;
  unpaidCharges: number;
  unknownCharges: number;
  makeupOwed: number;
  paymentMode: "AUTO" | "MANUAL";
  hasOpenRequest: boolean;
}

export interface AdminShiftFilters {
  status?: string;
  roomKey?: string;
  weekday?: number;
  query?: string;
}

export async function listShiftsAdmin(filters: AdminShiftFilters = {}, db: PrismaClient = defaultDb, now: Date = new Date()): Promise<AdminShiftRow[]> {
  const where: Prisma.ShiftWhereInput = {};
  if (filters.status) where.status = filters.status as never;
  if (filters.roomKey) where.room = { key: filters.roomKey as never };
  if (filters.weekday !== undefined) where.weekday = filters.weekday;
  const q = filters.query?.trim();
  if (q) where.user = { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] };

  const rows = await db.shift.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
    include: { user: { select: { id: true, name: true, email: true, phone: true } }, room: true, charges: true, requests: { where: { status: "PENDING" } }, occurrences: { select: { id: true, date: true, startTime: true, endTime: true, status: true, makeupStatus: true, makeupNote: true, makeupCreditId: true } } },
  });
  const credits = await loadMakeupCredits(db, rows);
  return rows.map((s) => ({
    id: s.id,
    user: s.user,
    room: { key: s.room.key, name: s.room.name },
    weekday: s.weekday,
    windowId: s.windowId,
    startDate: s.startDate,
    endDate: s.endDate,
    status: s.status,
    suspensionReason: s.suspensionReason,
    scheduled: s.occurrences.filter((o) => o.status === "SCHEDULED").length,
    // חיובים שמועדם הגיע ועדיין לא שולמו (נכשלו או ממתינים לתשלום; חיובים עתידיים אינם חוב)
    unpaidCharges: s.charges.filter((c) => (c.status === "FAILED" || c.status === "PENDING") && (c.dueDate === null || c.dueDate <= jerusalemTodayIso(now))).length,
    // שעות חלופיות עם יתרה פתוחה (או שטרם ניתן להן זיכוי)
    makeupOwed: s.occurrences.filter((o) => o.makeupStatus !== null).map((o) => makeupViewOf(o, credits, now)).filter((m) => m.state === "OPEN" || m.state === "PENDING_GRANT").length,
    paymentMode: s.paymentMode,
    unknownCharges: s.charges.filter((c) => c.status === "UNKNOWN").length,
    hasOpenRequest: s.requests.length > 0,
  }));
}

export interface AdminShiftDetail extends ShiftView {
  user: { id: string; name: string; email: string | null; phone: string | null };
  occurrences: { id: string; date: string; month: string; status: string; statusNote: string | null; priceAgorot: number; refundedAgorot: number; makeupStatus: string | null; makeupNote: string | null; startTime: string; endTime: string }[];
  chargePayments: Record<string, { status: string; failureCode: string | null }>;
}

export async function getShiftAdminDetail(shiftId: string, now: Date = new Date(), db: PrismaClient = defaultDb): Promise<AdminShiftDetail | null> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    include: { ...include, user: { select: { id: true, name: true, email: true, phone: true } } },
  });
  if (!shift) return null;
  const payments = await db.payment.findMany({ where: { id: { in: shift.charges.map((c) => c.paymentId).filter((x): x is string => !!x) } }, select: { id: true, status: true, failureCode: true } });
  const byId = new Map(payments.map((p) => [p.id, p]));
  return {
    ...toShiftView(shift, now, await loadMakeupCredits(db, [shift])),
    user: shift.user,
    occurrences: [...shift.occurrences]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((o) => ({ id: o.id, date: o.date, month: o.month, status: o.status, statusNote: o.statusNote, priceAgorot: o.priceAgorot, refundedAgorot: o.refundedAgorot, makeupStatus: o.makeupStatus, makeupNote: o.makeupNote, startTime: o.startTime.toISOString(), endTime: o.endTime.toISOString() })),
    chargePayments: Object.fromEntries(
      shift.charges.filter((c) => c.paymentId && byId.has(c.paymentId)).map((c) => [c.id, { status: byId.get(c.paymentId!)!.status, failureCode: byId.get(c.paymentId!)!.failureCode }])
    ),
  };
}

export async function listPendingShiftRequests(db: PrismaClient = defaultDb) {
  const rows = await db.shiftChangeRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true, phone: true } }, shift: { include: { room: true } } },
    take: 100,
  });
  return rows.map((r) => ({
    ...toRequestView(r),
    user: r.user,
    shift: { id: r.shift.id, room: { key: r.shift.room.key, name: r.shift.room.name }, weekday: r.shift.weekday, windowId: r.shift.windowId, startDate: r.shift.startDate, endDate: r.shift.endDate, status: r.shift.status },
  }));
}

/** לקוחות לניהול זכאות: כל מי שיש לו הרשאה, ואם יש חיפוש: לקוחות תואמים (עד 20) */
export async function listEligibility(query: string | undefined, db: PrismaClient = defaultDb) {
  const q = query?.trim();
  const rows = await db.user.findMany({
    where: {
      role: "CLIENT",
      ...(q
        ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] }
        : { canBookShifts: true }),
    },
    select: { id: true, name: true, email: true, phone: true, status: true, canBookShifts: true },
    orderBy: { name: "asc" },
    take: 20,
  });
  return rows;
}

export async function recentCronRuns(limit = 10, db: PrismaClient = defaultDb) {
  const rows = await db.cronRun.findMany({ where: { job: "shift-billing" }, orderBy: { startedAt: "desc" }, take: limit });
  return rows.map((r) => ({ id: r.id, period: r.period, trigger: r.trigger, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), summary: r.summary }));
}
