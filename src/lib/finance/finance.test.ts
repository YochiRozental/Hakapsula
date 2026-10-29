import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";

// בדיקות הניהול הכספי (שלב H) מול PostgreSQL מקומי ייעודי: חובות והסדרתם, חסימות, הזמנה עם חוב, החזרים (רגיל/חריג/כפול/כשל ספק/
// לא ידוע), ביטול חבילות (כולל מקביליות), תור הבירור, שילוב חיובי משמרות ויומן ביקורת. רצות רק כש-FINANCE_TEST_DATABASE_URL
// מוגדר ומצביע על מסד מקומי בשם *_test:  FINANCE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_finance_test npm test
const testUrl = process.env.FINANCE_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (!local || !parsed.pathname.replace(/^\//, "").endsWith("_test")) throw new Error("FINANCE_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
}

const SECRET = "finance-test-secret-0123456789ab";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("ניהול כספי: מול PostgreSQL מקומי", { skip: !testUrl && "FINANCE_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let debts: typeof import("@/lib/finance/debts");
  let debtBooking: typeof import("@/lib/finance/debt-booking");
  let blocks: typeof import("@/lib/finance/blocks");
  let refunds: typeof import("@/lib/finance/refunds");
  let pkgCancel: typeof import("@/lib/finance/package-cancel");
  let unknown: typeof import("@/lib/finance/unknown");
  let overview: typeof import("@/lib/finance/overview");
  let audit: typeof import("@/lib/finance/audit");
  let flag: typeof import("@/lib/finance/flag");
  let gate: typeof import("@/lib/finance/gate");
  let payBooking: typeof import("@/lib/payments/booking-payment");
  let pkgs: typeof import("@/lib/payments/packages");
  let shiftSvc: typeof import("@/lib/shifts/schedule");
  let shiftBill: typeof import("@/lib/shifts/billing");
  let methods: typeof import("@/lib/payments/saved-methods");
  let hoursDb: typeof import("@/lib/opening-hours-db");
  let pw: typeof import("@/lib/password");
  let MockPaymentProvider: typeof import("@/lib/payments/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let PaymentStateError: typeof import("@/lib/payments/provider").PaymentStateError;
  let provider: InstanceType<typeof MockPaymentProvider>;
  const ids: Record<string, string> = {};
  let counter = 0;
  const key = () => `key-${Date.now()}-${counter++}-abcdefgh`;
  let savedRefund: typeof MockPaymentProvider.prototype.refund;
  let savedCharge: typeof MockPaymentProvider.prototype.chargeSavedMethod;

  async function wipe() {
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.refundReview.deleteMany({});
    await prisma.packageCancellationRequest.deleteMany({});
    await prisma.creditUsage.deleteMany({});
    await prisma.packageUsage.deleteMany({});
    await prisma.credit.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.shiftChangeRequest.deleteMany({});
    await prisma.shiftCharge.deleteMany({});
    await prisma.shiftOccurrence.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.cronRun.deleteMany({});
    await prisma.hoursPackage.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.appointment.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.openingWindow.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = (await import("@/lib/prisma")) as { prisma: PrismaClient });
    debts = await import("@/lib/finance/debts");
    debtBooking = await import("@/lib/finance/debt-booking");
    blocks = await import("@/lib/finance/blocks");
    refunds = await import("@/lib/finance/refunds");
    pkgCancel = await import("@/lib/finance/package-cancel");
    unknown = await import("@/lib/finance/unknown");
    overview = await import("@/lib/finance/overview");
    audit = await import("@/lib/finance/audit");
    flag = await import("@/lib/finance/flag");
    gate = await import("@/lib/finance/gate");
    payBooking = await import("@/lib/payments/booking-payment");
    pkgs = await import("@/lib/payments/packages");
    shiftSvc = await import("@/lib/shifts/schedule");
    shiftBill = await import("@/lib/shifts/billing");
    methods = await import("@/lib/payments/saved-methods");
    hoursDb = await import("@/lib/opening-hours-db");
    pw = await import("@/lib/password");
    ({ MockPaymentProvider } = await import("@/lib/payments/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    ({ PaymentStateError } = await import("@/lib/payments/provider"));
    savedRefund = MockPaymentProvider.prototype.refund;
    savedCharge = MockPaymentProvider.prototype.chargeSavedMethod;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "fin " } } });
  });

  beforeEach(async () => {
    MockPaymentProvider.prototype.refund = savedRefund;
    MockPaymentProvider.prototype.chargeSavedMethod = savedCharge;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "fin " } } });
    provider = new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));
    const passwordHash = await pw.hashPassword(SITE_PASSWORD);
    const mk = async (k: string, extra: Record<string, unknown> = {}) => {
      ids[k] = (await prisma.user.create({ data: { name: `fin ${k}`, email: `fin-${k}@test.local`, passwordHash, gender: "MALE", status: "APPROVED", ...(extra as object) } as never })).id;
    };
    await mk("a");
    await mk("b");
    await mk("admin", { role: "ADMIN" });
    await mk("admin2", { role: "ADMIN" });
  });

  after(async () => {
    if (!prisma) return;
    MockPaymentProvider.prototype.refund = savedRefund;
    MockPaymentProvider.prototype.chargeSavedMethod = savedCharge;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "fin " } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────
  let slotCounter = 0;
  /** חלון של שעה בעתיד הרחוק, ייחודי לכל קריאה (אין התנגשויות בין בדיקות) */
  /** היום ה-k שאינו שבת (המכון סגור בשבת גם להזמנת מנהל) */
  function nthOpenDay(k: number) {
    const d = new Date(Date.UTC(2040, 0, 2));
    while (k > 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() !== 6) k--;
    }
    return d;
  }
  function slot(minutes = 60, daysAhead = 3) {
    const n = slotCounter++;
    const day = nthOpenDay(daysAhead + Math.floor(n / 10));
    const startTime = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6 + (n % 10), 0, 0));
    return { startTime, endTime: new Date(startTime.getTime() + minutes * 60_000) };
  }
  /** הזמנה ששולמה בכסף דרך הספק (Mock) ואושרה */
  async function paidBooking(userId: string, opts: { startTime?: Date; minutes?: number } = {}) {
    const s = opts.startTime ? { startTime: opts.startTime, endTime: new Date(opts.startTime.getTime() + (opts.minutes ?? 60) * 60_000) } : slot(opts.minutes ?? 60);
    const hold = await payBooking.holdRoom({ userId, roomKey: "ROOM3", ...s, source: "ADMIN" });
    const started = await payBooking.startBookingPayment({ appointmentId: hold.id, userId, provider, useBalance: false });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    const fin = await payBooking.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    assert.equal(fin.outcome, "CONFIRMED", JSON.stringify(fin));
    return { appointmentId: hold.id, paymentId: started.paymentId, amountAgorot: started.amountAgorot };
  }
  async function buyPackage(userId: string, hours = 5) {
    const started = await pkgs.startPackagePurchase({ userId, hours, clientKey: key(), provider });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    const res = await pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider });
    assert.equal(res.outcome, "PACKAGE_ACTIVATED");
    return prisma.hoursPackage.findUniqueOrThrow({ where: { paymentId: started.paymentId } });
  }
  async function bookFromBalance(userId: string) {
    const hold = await payBooking.holdRoom({ userId, roomKey: "ROOM4", ...slot(60), source: "ADMIN" });
    return payBooking.confirmBookingFromBalance({ appointmentId: hold.id, userId, provider });
  }
  const debtBookingInput = (userId: string, over: Partial<Parameters<typeof debtBooking.approveBookingWithDebt>[0]> = {}) => {
    const d = new Date(Date.now() + 5 * DAY);
    while (d.getUTCDay() === 6 || d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 1); // שבת סגורה; שישי עלול להיות מקוצר
    const date = d.toISOString().slice(0, 10);
    return { userId, roomKey: "ROOM2" as const, date, start: "10:00", durationMinutes: 60, adminId: ids.admin, confirm: true, expectedDebtAgorot: 5200, ...over };
  };
  async function openDebt(userId = ids.a, over: Partial<Parameters<typeof debtBooking.approveBookingWithDebt>[0]> = {}) {
    const res = await debtBooking.approveBookingWithDebt(debtBookingInput(userId, over));
    assert.ok(res.debtId);
    return res.debtId!;
  }
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (e: { code?: string }) => e.code === code, `expected ${code}`);
  const auditCount = (action: string, entityId?: string) => prisma.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });

  // ───────────── תשלומים: צפייה וסינון ─────────────

  test("1-2. ספר תנועות: צפייה בתשלומים, סינון לפי סטטוס, לקוח וטווח תאריכים", async () => {
    const paid = await paidBooking(ids.a);
    const hold = await payBooking.holdRoom({ userId: ids.b, roomKey: "ROOM3", ...slot(), source: "ADMIN" });
    const started = await payBooking.startBookingPayment({ appointmentId: hold.id, userId: ids.b, provider, useBalance: false });
    await provider.completeCheckout(started.providerPaymentId!, "failure");
    await payBooking.finalizeBookingPayment({ paymentId: started.paymentId, provider });

    const all = await overview.getLedger({});
    assert.equal(all.filter((r) => r.type === "PAYMENT").length, 2);
    const failed = await overview.getLedger({ status: "FAILED" });
    assert.deepEqual(failed.map((r) => r.ref), [started.paymentId]);
    const mine = await overview.getLedger({ userId: ids.a });
    assert.deepEqual(mine.map((r) => r.ref), [paid.paymentId]);
    assert.equal(mine[0].amountAgorot, paid.amountAgorot);
    const byName = await overview.getLedger({ q: "fin b" });
    assert.ok(byName.every((r) => r.user.id === ids.b));
    const future = new Date(Date.now() + 30 * DAY);
    assert.equal((await overview.getLedger({ from: future })).length, 0);
    assert.equal((await overview.getLedger({ to: new Date(Date.now() - 30 * DAY) })).length, 0);
    assert.equal((await overview.getLedger({ from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) })).length, 2);
  });

  test("תמונת מצב: נגבה בפועל, חוב שטרם נגבה, החזרים וויתורים מופרדים; לא מחושב מהזמנות", async () => {
    await paidBooking(ids.a); // 5200 ש"ח? 60 דק' = 4 רבעים
    const debtId = await openDebt(ids.b);
    await debts.waiveDebt({ debtId, adminId: ids.admin, amountAgorot: 1000, reason: "ויתור חלקי", clientKey: key() });
    const o = await overview.getFinanceOverview({}, true);
    assert.equal(o.collected.grossAgorot, 5200);
    assert.equal(o.collected.netAgorot, 5200);
    assert.equal(o.debts.openCount, 1);
    assert.equal(o.debts.openAgorot, 4200);
    assert.equal(o.debts.waivedAgorot, 1000);
    assert.equal(o.outstandingNotCollectedAgorot, 4200);
    // ההזמנה עם החוב אינה נספרת ככסף שנגבה
    assert.equal(o.collected.grossAgorot, 5200);
  });

  // ───────────── חובות ─────────────

  test("3. חוב פתוח אינו חוסם לקוח: הוא ממשיך להיות מאושר וניתן לאשר לו הזמנות", async () => {
    await openDebt(ids.a);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.a } })).status, "APPROVED");
    const q = await debtBooking.quoteDebtBooking(debtBookingInput(ids.a, { start: "12:00" }));
    assert.equal(q.available, true);
    const list = await debts.listDebts({ userId: ids.a });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "OPEN");
    assert.equal(list[0].remainingAgorot, 5200);
    assert.equal(list[0].source.kind, "BOOKING");
  });

  test("4. הסדרת חוב: נדרשת אסמכתה ואישור מפורש; הסדרה מלאה סוגרת כ'שולם בפועל'; חזרה על אותה פעולה אינה מכפילה", async () => {
    const debtId = await openDebt();
    const base = { debtId, adminId: ids.admin, amountAgorot: 5200, reference: "REC-1001", confirmedExternalPayment: true, clientKey: key() };
    await rejects(debts.settleDebtExternal({ ...base, reference: "" }), "INVALID");
    await rejects(debts.settleDebtExternal({ ...base, confirmedExternalPayment: false }), "INVALID");
    await rejects(debts.settleDebtExternal({ ...base, clientKey: "x" }), "INVALID");
    assert.equal((await prisma.debt.findUniqueOrThrow({ where: { id: debtId } })).status, "OPEN");

    const a = await debts.settleDebtExternal(base);
    assert.equal(a.debt.status, "PAID");
    assert.equal(a.debt.paidAgorot, 5200);
    assert.ok(a.debt.resolvedAt);
    const again = await debts.settleDebtExternal(base);
    assert.equal(again.replayed, true);
    assert.equal(await prisma.debtSettlement.count({ where: { debtId } }), 1);
    await rejects(debts.settleDebtExternal({ ...base, clientKey: key() }), "CONFLICT");
    assert.ok((await auditCount("DEBT_SETTLED", debtId)) >= 1);
    const view = (await debts.getDebt(debtId))!;
    assert.equal(view.classification, "PAID_ACTUAL");
    assert.equal(view.settlements[0].reference, "REC-1001");
  });

  test("5. ויתור על חוב: סיבה חובה; החוב נשמר ונסגר כ'נמחל' ולא כ'שולם'; לא נמחק", async () => {
    const debtId = await openDebt();
    await rejects(debts.waiveDebt({ debtId, adminId: ids.admin, reason: "", clientKey: key() }), "INVALID");
    const res = await debts.waiveDebt({ debtId, adminId: ids.admin, reason: "הלקוח זכאי להנחה", clientKey: key() });
    assert.equal(res.debt.status, "WAIVED");
    assert.equal(res.debt.waivedAgorot, 5200);
    assert.equal(res.debt.paidAgorot, 0);
    assert.ok(await prisma.debt.findUnique({ where: { id: debtId } }), "החוב לא נמחק");
    const view = (await debts.getDebt(debtId))!;
    assert.equal(view.classification, "WAIVED");
    assert.equal(view.settlements[0].kind, "WAIVER");
    assert.equal(await auditCount("DEBT_WAIVED", debtId), 1);
  });

  test("6. הסדרה חלקית: היתרה יורדת, אין יתרה שלילית, וויתור על היתרה סוגר; אילוצי המסד חוסמים חריגה", async () => {
    const debtId = await openDebt();
    await debts.settleDebtExternal({ debtId, adminId: ids.admin, amountAgorot: 2000, reference: "TRF-77", confirmedExternalPayment: true, clientKey: key() });
    let d = (await debts.getDebt(debtId))!;
    assert.equal(d.status, "OPEN");
    assert.equal(d.remainingAgorot, 3200);
    await rejects(debts.settleDebtExternal({ debtId, adminId: ids.admin, amountAgorot: 3201, reference: "TRF-78", confirmedExternalPayment: true, clientKey: key() }), "INVALID");
    await rejects(debts.waiveDebt({ debtId, adminId: ids.admin, amountAgorot: 3201, reason: "יותר מדי", clientKey: key() }), "INVALID");
    await rejects(debts.settleDebtExternal({ debtId, adminId: ids.admin, amountAgorot: -5, reference: "TRF-79", confirmedExternalPayment: true, clientKey: key() }), "INVALID");
    await debts.waiveDebt({ debtId, adminId: ids.admin, reason: "מחילה על היתרה", clientKey: key() });
    d = (await debts.getDebt(debtId))!;
    assert.equal(d.status, "WAIVED");
    assert.equal(d.paidAgorot, 2000);
    assert.equal(d.waivedAgorot, 3200);
    assert.equal(d.remainingAgorot, 0);
    // רשת ביטחון במסד: גם עדכון ישיר שחורג נחסם
    await assert.rejects(prisma.$executeRaw`UPDATE "Debt" SET "paidAgorot" = "amountAgorot" + 1 WHERE id = ${debtId}`);
    await assert.rejects(prisma.$executeRaw`UPDATE "Debt" SET "status" = 'OPEN' WHERE id = ${debtId}`); // פתוח ללא יתרה
    await assert.rejects(prisma.$executeRaw`UPDATE "Debt" SET "waivedAgorot" = 0 WHERE id = ${debtId}`); // סגור שאינו מוסדר במלואו
  });

  test("חוב בבירור: אי אפשר להסדיר בתשלום עד הכרעה; ניתן לוותר או להחזיר לפתוח", async () => {
    const debtId = await openDebt();
    await rejects(debts.setDebtReview({ debtId, adminId: ids.admin, inReview: true, note: "" }), "INVALID");
    await debts.setDebtReview({ debtId, adminId: ids.admin, inReview: true, note: "ממתין לאסמכתה מהלקוח" });
    assert.equal((await debts.getDebt(debtId))!.classification, "IN_REVIEW");
    await rejects(debts.settleDebtExternal({ debtId, adminId: ids.admin, amountAgorot: 100, reference: "REC-5", confirmedExternalPayment: true, clientKey: key() }), "CONFLICT");
    await debts.setDebtReview({ debtId, adminId: ids.admin, inReview: false, note: "הוגדר מחדש" });
    assert.equal((await prisma.debt.findUniqueOrThrow({ where: { id: debtId } })).status, "OPEN");
    assert.equal((await overview.getFinanceOverview({}, false)).debts.inReviewCount, 0);
  });

  test("מקביליות בחוב: הסדרות וויתורים מקבילים אף פעם לא חורגים מהסכום", async () => {
    const debtId = await openDebt();
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => debts.settleDebtExternal({ debtId, adminId: ids.admin, amountAgorot: 2000, reference: "PAR-1", confirmedExternalPayment: true, clientKey: key() })),
      ...Array.from({ length: 4 }, () => debts.waiveDebt({ debtId, adminId: ids.admin2, amountAgorot: 1500, reason: "ויתור מקבילי", clientKey: key() })),
    ]);
    const d = await prisma.debt.findUniqueOrThrow({ where: { id: debtId } });
    assert.ok(d.paidAgorot + d.waivedAgorot <= d.amountAgorot);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(await prisma.debtSettlement.count({ where: { debtId } }), ok);
    const sum = (await prisma.debtSettlement.aggregate({ where: { debtId }, _sum: { amountAgorot: true } }))._sum.amountAgorot!;
    assert.equal(sum, d.paidAgorot + d.waivedAgorot);
  });

  test("אין חוב כפול: אותה התחייבות (הזמנה) נושאת חוב אחד; לחיצה כפולה/מקבילה יוצרת הזמנה וחוב אחד", async () => {
    const input = debtBookingInput(ids.a, { start: "15:00" });
    const res = await Promise.allSettled(Array.from({ length: 4 }, () => debtBooking.approveBookingWithDebt(input)));
    // אותה בקשה חוזרת (אותו לקוח, חדר ושעה) מחזירה את אותה הזמנה וחוב: ללא כפילות
    const ok = res.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof debtBooking.approveBookingWithDebt>>> => r.status === "fulfilled");
    assert.ok(ok.length >= 1);
    assert.equal(new Set(ok.map((r) => r.value.debtId)).size, 1);
    assert.equal(new Set(ok.map((r) => r.value.appointmentId)).size, 1);
    assert.equal(await prisma.debt.count({ where: { userId: ids.a } }), 1);
    assert.equal(await auditCount("BOOKING_APPROVED_WITH_DEBT", ok[0].value.debtId!), 1);
    assert.equal(await prisma.appointment.count({ where: { userId: ids.a, status: "CONFIRMED" } }), 1);
  });

  // ───────────── חסימות ─────────────

  test("7-8. חסימה ושחרור: רק חסימה מפורשת (סיבה חובה), מתועדת לפני/אחרי; לא חוסמים מנהל; חסום לא מקבל הזמנת חוב", async () => {
    await rejects(blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.a, blocked: true, reason: "" }), "INVALID");
    await rejects(blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.admin2, blocked: true, reason: "ניסיון" }), "NOT_FOUND");
    await rejects(blocks.setCustomerBlock({ adminId: ids.a, userId: ids.a, blocked: true, reason: "עצמי" }), "INVALID");
    await blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.a, blocked: true, reason: "חובות חוזרים" });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.a } })).status, "BLOCKED");
    await rejects(blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.a, blocked: true, reason: "שוב" }), "CONFLICT");
    await rejects(debtBooking.quoteDebtBooking(debtBookingInput(ids.a)), "CONFLICT");
    await blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.a, blocked: false, reason: "הוסדר" });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.a } })).status, "APPROVED");
    await rejects(blocks.setCustomerBlock({ adminId: ids.admin, userId: ids.a, blocked: false, reason: "שוב" }), "CONFLICT");
    const entries = await prisma.auditLog.findMany({ where: { entityId: ids.a, action: { in: ["CUSTOMER_BLOCKED", "CUSTOMER_UNBLOCKED"] } }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(entries.map((e) => e.action), ["CUSTOMER_BLOCKED", "CUSTOMER_UNBLOCKED"]);
    assert.deepEqual(entries[0].before, { status: "APPROVED" });
    assert.deepEqual(entries[0].after, { status: "BLOCKED" });
  });

  // ───────────── אישור הזמנה עם חוב ─────────────

  test("9. אישור הזמנה עם חוב: הצגת סכומים, אישור מפורש וסכום צפוי, יצירה אטומית עם ביקורת; ללא עקיפת זמינות", async () => {
    const quote = await debtBooking.quoteDebtBooking(debtBookingInput(ids.a));
    assert.equal(quote.bookingAmountAgorot, 5200);
    assert.equal(quote.debtAgorot, 5200);
    assert.equal(quote.available, true);
    await rejects(debtBooking.approveBookingWithDebt(debtBookingInput(ids.a, { confirm: false })), "INVALID");
    await rejects(debtBooking.approveBookingWithDebt(debtBookingInput(ids.a, { expectedDebtAgorot: 100 })), "CONFLICT");
    assert.equal(await prisma.debt.count(), 0);
    assert.equal(await prisma.appointment.count(), 0);

    const res = await debtBooking.approveBookingWithDebt(debtBookingInput(ids.a));
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: res.appointmentId } });
    assert.equal(appt.status, "CONFIRMED");
    assert.equal(appt.paymentStatus, "DEBT");
    const debt = await prisma.debt.findUniqueOrThrow({ where: { id: res.debtId! } });
    assert.equal(debt.amountAgorot, 5200);
    assert.equal(debt.createdById, ids.admin);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "BOOKING_APPROVED_WITH_DEBT", entityId: debt.id } });
    assert.equal(entry.adminId, ids.admin);
    assert.equal(entry.userId, ids.a);

    // אותה שעה/חדר תפוסים: לא עוקפים זמינות, ולא נוצר חוב נוסף
    const q2 = await debtBooking.quoteDebtBooking(debtBookingInput(ids.b));
    assert.equal(q2.available, false);
    await assert.rejects(debtBooking.approveBookingWithDebt(debtBookingInput(ids.b)));
    assert.equal(await prisma.debt.count(), 1);
    assert.equal(await prisma.appointment.count({ where: { userId: ids.b } }), 0);
  });

  test("10. לקוח אינו יכול ליצור לעצמו הזמנה עם חוב (השירות דורש מנהל)", async () => {
    const s = slot();
    await assert.rejects(
      payBooking.createAdminBookingWithDebt({ adminId: ids.a, userId: ids.a, roomKey: "ROOM1", startTime: s.startTime, endTime: s.endTime }),
      (e: { code?: string }) => e.code === "FORBIDDEN"
    );
    assert.equal(await prisma.debt.count(), 0);
  });

  test("ביטול מוקדם של הזמנה עם חוב סוגר את החוב כנמחל (שומר על אילוצי החוב)", async () => {
    const date = new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10);
    const res = await debtBooking.approveBookingWithDebt(debtBookingInput(ids.a, { date, start: "09:00" }));
    const cancel = await payBooking.cancelBooking({ appointmentId: res.appointmentId, requester: { id: ids.a, role: "CLIENT" }, provider });
    assert.equal(cancel.debtWaived, true);
    const d = await prisma.debt.findUniqueOrThrow({ where: { id: res.debtId! } });
    assert.equal(d.status, "WAIVED");
    assert.equal(d.waivedAgorot, d.amountAgorot);
  });

  // ───────────── החזרים ─────────────

  test("11. החזר רגיל (ביטול 24+ שעות): מלא, נרשם בספר התנועות ובסכומים", async () => {
    const paid = await paidBooking(ids.a);
    const res = await payBooking.cancelBooking({ appointmentId: paid.appointmentId, requester: { id: ids.a, role: "CLIENT" }, provider });
    assert.equal(res.outcome, "REFUNDED");
    const o = await overview.getFinanceOverview({}, false);
    assert.equal(o.collected.grossAgorot, 5200);
    assert.equal(o.collected.refundedAgorot, 5200);
    assert.equal(o.collected.netAgorot, 0);
    assert.equal(o.refunds.doneCount, 1);
    assert.equal((await overview.getLedger({ type: "REFUND" }))[0].status, "SUCCEEDED");
  });

  test("12. החזר חריג: ביטול מאוחר ללא החזר, המנהל מאשר או דוחה עם סיבה; ההכרעה חד-פעמית", async () => {
    const late = new Date(Date.now() + 3 * HOUR);
    late.setMinutes(Math.ceil(late.getMinutes() / 15) * 15, 0, 0);
    const a = await paidBooking(ids.a, { startTime: late });
    const cancelled = await payBooking.cancelBooking({ appointmentId: a.appointmentId, requester: { id: ids.a, role: "CLIENT" }, provider });
    assert.equal(cancelled.outcome, "CANCELLED_NO_REFUND");
    const queue = await refunds.listRefundExceptions();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].refundableAgorot, 5200);

    await rejects(refunds.decideRefundException({ appointmentId: a.appointmentId, adminId: ids.admin, provider, decision: "APPROVE", reason: "" }), "INVALID");
    const ok = await refunds.decideRefundException({ appointmentId: a.appointmentId, adminId: ids.admin, provider, decision: "APPROVE", reason: "אירוע רפואי מתועד" });
    assert.equal(ok.decision, "APPROVE");
    assert.equal((await prisma.refund.findFirstOrThrow({ where: { paymentId: a.paymentId } })).status, "SUCCEEDED");
    await rejects(refunds.decideRefundException({ appointmentId: a.appointmentId, adminId: ids.admin2, provider, decision: "APPROVE", reason: "שוב" }), "CONFLICT");
    assert.equal(await prisma.refund.count({ where: { paymentId: a.paymentId } }), 1);
    assert.equal((await refunds.listRefundExceptions()).length, 0);
    assert.equal(await auditCount("REFUND_EXCEPTION_APPROVED", a.appointmentId), 1);

    const lateB = new Date(late.getTime() + 2 * HOUR);
    const b = await paidBooking(ids.b, { startTime: lateB });
    await payBooking.cancelBooking({ appointmentId: b.appointmentId, requester: { id: ids.b, role: "CLIENT" }, provider });
    await refunds.decideRefundException({ appointmentId: b.appointmentId, adminId: ids.admin, provider, decision: "REJECT", reason: "ביטול מאוחר ללא נימוק" });
    assert.equal(await prisma.refund.count({ where: { paymentId: b.paymentId } }), 0);
    assert.equal((await refunds.listRefundExceptions()).length, 0);
    assert.equal(await auditCount("REFUND_EXCEPTION_REJECTED", b.appointmentId), 1);
  });

  test("החזר מנהל חלקי: עד היתרה בלבד, רק על תשלום הזמנה, ומוצלח רק אחרי אישור הספק", async () => {
    const paid = await paidBooking(ids.a);
    const first = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 2000, reason: "פיצוי חלקי", clientKey: key(), exception: true });
    assert.equal(first.status, "SUCCEEDED");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: paid.appointmentId } })).paymentStatus, "PAID");
    await rejects(refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 3201, reason: "יותר מדי", clientKey: key() }), "INVALID");
    await rejects(refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 100, reason: "", clientKey: key() }), "INVALID");
    const rest = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 3200, reason: "יתרת ההחזר", clientKey: key() });
    assert.equal(rest.status, "SUCCEEDED");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: paid.appointmentId } })).paymentStatus, "REFUNDED");
    assert.equal((await prisma.mockProviderRecord.findUnique({ where: { key: `pay:${(await prisma.payment.findUniqueOrThrow({ where: { id: paid.paymentId } })).providerPaymentId}` } }))!.data && true, true);
    // חבילה: לא מוחזרת בכלי הזה
    const pkg = await buyPackage(ids.a, 5);
    await rejects(refunds.issueAdminRefund({ paymentId: pkg.paymentId!, adminId: ids.admin, provider, amountAgorot: 100, reason: "אסור", clientKey: key() }), "INVALID");
  });

  test("13. החזר כפול: אותו מפתח = החזר אחד; מפתחות שונים ובמקביל לא חורגים מהסכום ששולם", async () => {
    const paid = await paidBooking(ids.a);
    const k = key();
    const r1 = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "החזר מלא", clientKey: k });
    const r2 = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "החזר מלא", clientKey: k });
    assert.equal(r1.refundId, r2.refundId);
    assert.equal(r2.replayed, true);
    assert.equal(await prisma.refund.count({ where: { paymentId: paid.paymentId } }), 1);
    await rejects(refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 100, reason: "עוד", clientKey: key() }), "INVALID");

    const paid2 = await paidBooking(ids.b);
    const par = await Promise.allSettled(Array.from({ length: 5 }, () => refunds.issueAdminRefund({ paymentId: paid2.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "מקבילי", clientKey: key() })));
    assert.equal(par.filter((r) => r.status === "fulfilled").length, 1);
    const total = (await prisma.refund.aggregate({ where: { paymentId: paid2.paymentId, status: { not: "FAILED" } }, _sum: { amountAgorot: true } }))._sum.amountAgorot;
    assert.equal(total, 5200);
  });

  test("14. כשל ספק: דחייה ודאית = נכשל (והתקרה מתפנה); שגיאה לא ידועה = ממתין בבירור, ללא ניסיון חוזר עיוור", async () => {
    const paid = await paidBooking(ids.a);
    MockPaymentProvider.prototype.refund = async () => {
      throw new PaymentStateError("rejected");
    };
    const failed = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "ניסיון", clientKey: key() });
    assert.equal(failed.status, "FAILED");
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: failed.refundId } })).status, "FAILED");
    MockPaymentProvider.prototype.refund = savedRefund;
    const retry = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "ניסיון חוזר מתועד", clientKey: key() });
    assert.equal(retry.status, "SUCCEEDED");

    const paid2 = await paidBooking(ids.b);
    let calls = 0;
    MockPaymentProvider.prototype.refund = async () => {
      calls++;
      throw new Error("network timeout");
    };
    const unknownRes = await refunds.issueAdminRefund({ paymentId: paid2.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "תקלת רשת", clientKey: key() });
    assert.equal(unknownRes.status, "UNKNOWN");
    assert.equal(calls, 1);
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: unknownRes.refundId } })).status, "PENDING");
    // לא ניתן לשלוח שוב באופן עיוור, וגם לא להחזיר שוב את אותו סכום
    await rejects(refunds.sendUnsentRefund({ refundId: unknownRes.refundId, adminId: ids.admin, provider }), "CONFLICT");
    await rejects(refunds.issueAdminRefund({ paymentId: paid2.paymentId, adminId: ids.admin, provider, amountAgorot: 100, reason: "עוד", clientKey: key() }), "INVALID");
    assert.equal(calls, 1);
    MockPaymentProvider.prototype.refund = savedRefund;

    const listed = await refunds.listRefunds({});
    assert.equal(listed.find((r) => r.id === unknownRes.refundId)!.state, "PENDING_UNKNOWN");
    const queue = await unknown.listUnknown(new Date(), false);
    assert.deepEqual(queue.refunds.map((r) => r.id), [unknownRes.refundId]);
    assert.equal(queue.refunds[0].inquiry.status, "AWAITING");
    await unknown.recordInquiryNote({ entityType: "Refund", entityId: unknownRes.refundId, adminId: ids.admin, note: "פנינו לספק" });
    assert.equal((await unknown.listUnknown(new Date(), false)).refunds[0].inquiry.status, "NOTED");

    // אימות מול הספק: הוא לא החזיר -> נכשל, ואפשר להנפיק החזר חדש
    const v = await refunds.verifyRefund({ refundId: unknownRes.refundId, adminId: ids.admin, provider });
    assert.equal(v.conclusion, "NOT_REFUNDED");
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: unknownRes.refundId } })).status, "FAILED");
    const again = await refunds.issueAdminRefund({ paymentId: paid2.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "אחרי אימות", clientKey: key() });
    assert.equal(again.status, "SUCCEEDED");
  });

  test("החזר שהספק ביצע אך התשובה אבדה: האימות מזהה הצלחה; הכרעה ידנית דורשת אסמכתה ונדחית כשהספק יודע לענות אחרת", async () => {
    const paid = await paidBooking(ids.a);
    MockPaymentProvider.prototype.refund = async function (this: InstanceType<typeof MockPaymentProvider>, input) {
      await savedRefund.call(this, input);
      throw new Error("response lost");
    };
    const res = await refunds.issueAdminRefund({ paymentId: paid.paymentId, adminId: ids.admin, provider, amountAgorot: 5200, reason: "אבדה תשובה", clientKey: key() });
    assert.equal(res.status, "UNKNOWN");
    MockPaymentProvider.prototype.refund = savedRefund;
    await rejects(refunds.resolveRefundManually({ refundId: res.refundId, adminId: ids.admin, provider, outcome: "FAILED", evidence: "" }), "INVALID");
    // הספק מדווח שהוחזר, ולכן הכרעה "נכשל" סותרת ונדחית
    await rejects(refunds.resolveRefundManually({ refundId: res.refundId, adminId: ids.admin, provider, outcome: "FAILED", evidence: "טענת הלקוח" }), "CONFLICT");
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: res.refundId } })).status, "SUCCEEDED");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: paid.appointmentId } })).paymentStatus, "REFUNDED");
  });

  // ───────────── ביטול חבילות ─────────────

  test("15. ביטול חבילה שלא נוצלה: אישור מאפס את היתרה, מחזיר את סכום ההחלטה, ואינו חוזר פעמיים", async () => {
    const pkg = await buyPackage(ids.a, 5);
    const req = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id, reason: "לא צריך" });
    const pending = await pkgCancel.listCancellationRequests();
    assert.equal(pending[0].package.minutesConsumed, 0);
    assert.equal(pending[0].package.refundableAgorot, 19500);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 300);

    await rejects(pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "" }), "INVALID");
    await rejects(pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "אישור", refundAgorot: 19501 }), "INVALID");
    assert.equal((await prisma.packageCancellationRequest.findUniqueOrThrow({ where: { id: req.id } })).status, "PENDING");

    const done = await pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "ביטול בתוך תקופת הניסיון", refundAgorot: 19500 });
    assert.equal(done.refundStatus, "SUCCEEDED");
    const after = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(after.minutesRemaining, 0);
    assert.ok(after.cancelledAt);
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: done.refundId! } })).amountAgorot, 19500);
    await rejects(pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin2, provider, decision: "APPROVE", reason: "שוב", refundAgorot: 19500 }), "CONFLICT");
    assert.equal(await prisma.refund.count({ where: { paymentId: pkg.paymentId! } }), 1);
    // הלקוח לא יכול לנצל יתרה מחבילה שבוטלה
    await assert.rejects(bookFromBalance(ids.a));
    assert.equal(await auditCount("PACKAGE_CANCEL_APPROVED", req.id), 1);
  });

  test("16. ביטול חבילה שנוצלה חלקית: המנהל קובע סכום (אין נוסחה אוטומטית), עד התקרה; דקות שחוזרות בהמשך הופכות לזיכוי", async () => {
    const pkg = await buyPackage(ids.a, 5);
    const used = await bookFromBalance(ids.a);
    assert.equal(used.outcome, "CONFIRMED");
    const req = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
    const row = (await pkgCancel.listCancellationRequests())[0];
    assert.equal(row.package.minutesConsumed, 60);
    assert.equal(row.package.minutesRemaining, 240);
    assert.equal(row.package.proportionalValueOfRemainingAgorot, 15600); // מידע בלבד
    const done = await pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "החזר חלקי לפי שיקול דעת", refundAgorot: 10000 });
    assert.equal(done.forfeitedMinutes, 240);
    assert.equal((await prisma.refund.findFirstOrThrow({ where: { paymentId: pkg.paymentId! } })).amountAgorot, 10000);
    // ביטול מאוחר של ההזמנה שנוצלה מהחבילה המבוטלת: הדקות הופכות לזיכוי ל-30 יום, לא חוזרות לחבילה
    const cancel = await payBooking.cancelBooking({ appointmentId: used.appointmentId, requester: { id: ids.a, role: "CLIENT" }, provider });
    assert.equal(cancel.creditedMinutes, 60);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 0);
    assert.equal(await prisma.credit.count({ where: { userId: ids.a } }), 1);
  });

  test("17. ניצול שעות בזמן שבקשה ממתינה: מותר; האישור קורא מחדש את היתרה העדכנית", async () => {
    const pkg = await buyPackage(ids.a, 5);
    const req = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
    await bookFromBalance(ids.a);
    await bookFromBalance(ids.a);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 180);
    const done = await pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "ללא החזר כספי" });
    assert.equal(done.forfeitedMinutes, 180);
    assert.equal(done.refundId, null);
    assert.equal(await prisma.refund.count(), 0);
  });

  test("18. בקשת ביטול מול אישור הזמנה מקביל: אין ניכוי אחרי האיפוס, והדקות מתאזנות", async () => {
    for (let round = 0; round < 4; round++) {
      await wipe();
      const pkg = await buyPackage(ids.a, 5);
      const req = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
      const holds = await Promise.all(Array.from({ length: 3 }, () => payBooking.holdRoom({ userId: ids.a, roomKey: "ROOM4", ...slot(60), source: "ADMIN" })));
      const results = await Promise.allSettled([
        pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "מקבילי" }),
        ...holds.map((h) => payBooking.confirmBookingFromBalance({ appointmentId: h.id, userId: ids.a, provider })),
      ]);
      assert.equal(results[0].status, "fulfilled", JSON.stringify(results[0]));
      const after = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      assert.equal(after.minutesRemaining, 0);
      const consumedByBookings = (await prisma.packageUsage.aggregate({ where: { packageId: pkg.id, kind: "CONSUME", appointmentId: { not: null } }, _sum: { minutes: true } }))._sum.minutes ?? 0;
      const forfeited = (await prisma.packageCancellationRequest.findUniqueOrThrow({ where: { id: req.id } })).forfeitedMinutes!;
      assert.equal(consumedByBookings + forfeited, 300, "כל הדקות מוסברות: ניצול + איפוס");
      const confirmed = results.slice(1).filter((r) => r.status === "fulfilled").length;
      assert.equal(consumedByBookings, confirmed * 60);
      assert.equal(await prisma.appointment.count({ where: { userId: ids.a, status: "CONFIRMED", paidFromBalanceMinutes: { gt: 0 } } }), confirmed);
    }
  });

  test("19. דחיית בקשה: החבילה נשארת פעילה ושמישה; סיבה חובה; אין החלטה כפולה ובמקביל רק אחת מצליחה", async () => {
    const pkg = await buyPackage(ids.a, 5);
    const req = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
    await rejects(pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "REJECT", reason: " " }), "INVALID");
    await pkgCancel.decideCancellationRequest({ requestId: req.id, adminId: ids.admin, provider, decision: "REJECT", reason: "החבילה בשימוש פעיל" });
    const p = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(p.cancelledAt, null);
    assert.equal(p.minutesRemaining, 300);
    assert.equal((await bookFromBalance(ids.a)).outcome, "CONFIRMED");
    assert.equal(await auditCount("PACKAGE_CANCEL_REJECTED", req.id), 1);

    const req2 = await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
    const par = await Promise.allSettled([
      pkgCancel.decideCancellationRequest({ requestId: req2.id, adminId: ids.admin, provider, decision: "APPROVE", reason: "מנהל א", refundAgorot: 5000 }),
      pkgCancel.decideCancellationRequest({ requestId: req2.id, adminId: ids.admin2, provider, decision: "APPROVE", reason: "מנהל ב", refundAgorot: 5000 }),
      pkgCancel.decideCancellationRequest({ requestId: req2.id, adminId: ids.admin2, provider, decision: "REJECT", reason: "מנהל ב דוחה" }),
    ]);
    assert.equal(par.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok((await prisma.refund.count({ where: { paymentId: pkg.paymentId! } })) <= 1);
  });

  // ───────────── תשלום לא ברור ─────────────

  test("20. תשלום תקוע: מופיע בתור; אימות מול הספק מסיים אותו; ללא הצלחה ידנית; הכרעה ידנית רק עם אסמכתה וכשאי אפשר לאמת", async () => {
    // תשלום ממתין שהספק כבר גבה, אך הלקוח לא חזר לאתר (webhook אבד)
    const hold = await payBooking.holdRoom({ userId: ids.a, roomKey: "ROOM3", ...slot(), source: "ADMIN" });
    const started = await payBooking.startBookingPayment({ appointmentId: hold.id, userId: ids.a, provider, useBalance: false });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    await prisma.payment.update({ where: { id: started.paymentId }, data: { createdAt: new Date(Date.now() - 2 * HOUR) } });
    // תשלום ממתין שנקטע לפני שנשמר מזהה הספק
    const hold2 = await payBooking.holdRoom({ userId: ids.b, roomKey: "ROOM1", ...slot(), source: "ADMIN" });
    const orphan = await prisma.payment.create({
      data: { userId: ids.b, appointmentId: hold2.id, purpose: "BOOKING", amountAgorot: 5200, status: "PENDING", environment: "SANDBOX", provider: "mock", idempotencyKey: `booking:${hold2.id}:1`, createdAt: new Date(Date.now() - 2 * HOUR) },
    });
    const queue = await unknown.listUnknown(new Date(), false);
    assert.deepEqual(queue.payments.map((p) => p.id).sort(), [started.paymentId, orphan.id].sort());
    const row = queue.payments.find((p) => p.id === orphan.id)!;
    assert.equal(row.verifiable, false);
    assert.equal(row.idempotencyKey, `booking:${hold2.id}:1`);

    // אי אפשר להכריע הצלחה ידנית; כישלון ידני נדחה ללא אסמכתה ובמקרה שהספק גבה בפועל
    await rejects(unknown.resolvePaymentManually({ paymentId: orphan.id, adminId: ids.admin, provider, outcome: "SUCCEEDED", evidence: "אסמכתה ארוכה" }), "INVALID");
    await rejects(unknown.resolvePaymentManually({ paymentId: orphan.id, adminId: ids.admin, provider, outcome: "FAILED", evidence: "" }), "INVALID");
    const v0 = await unknown.verifyPayment({ paymentId: orphan.id, adminId: ids.admin, provider });
    assert.equal(v0.conclusion, "UNVERIFIABLE");
    const man = await unknown.resolvePaymentManually({ paymentId: orphan.id, adminId: ids.admin, provider, outcome: "FAILED", evidence: "אישור הספק מס' 8841", note: "בירור טלפוני" });
    assert.equal(man.resolvedBy, "manual_unverified");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: orphan.id } })).status, "FAILED");
    assert.equal(await auditCount("PAYMENT_RESOLVED_MANUAL", orphan.id), 1);

    // התשלום שהספק גבה: אפילו אם המנהל מנסה לסמן 'נכשל', האימות קובע ומאשר את ההזמנה
    const forced = await unknown.resolvePaymentManually({ paymentId: started.paymentId, adminId: ids.admin, provider, outcome: "FAILED", evidence: "הלקוח אמר שלא שילם" });
    assert.equal(forced.resolvedBy, "provider_verification");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } })).status, "SUCCEEDED");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: hold.id } })).status, "CONFIRMED");
    assert.equal((await unknown.listUnknown(new Date(), false)).payments.length, 0);
  });

  // ───────────── משמרות ─────────────

  async function shiftWorld() {
    // "היום" הקבוע של בדיקות המשמרות (רביעי 10.2.2027); התחלה ביום שני 15.2.2027
    for (const wd of [1]) await hoursDb.replaceWeekday(wd, [{ startMinutes: 8 * 60, endMinutes: 23 * 60, activity: "BOYS" }], "BOYS", false);
    await prisma.user.update({ where: { id: ids.a }, data: { canBookShifts: true } });
    const added = await methods.addMockCard({ userId: ids.a, currentPassword: SITE_PASSWORD, provider });
    assert.equal(added.status, "OK");
    const NOW = new Date("2027-02-10T09:00:00Z");
    const res = await shiftSvc.createShift({ userId: ids.a, roomKey: "ROOM3", weekday: 1, windowId: "MORNING", startDate: "2027-02-15", clientKey: key(), provider, now: NOW });
    assert.equal(res.status, "ACTIVE", JSON.stringify(res));
    return { shiftId: res.shiftId, NOW };
  }

  test("21-22. חיוב משמרת שנכשל, תקופת חסד והשעיה מוצגים בתמונה הכספית בלי ספירה כפולה עם חובות", async () => {
    const { shiftId } = await shiftWorld();
    const card = await prisma.paymentMethod.findFirstOrThrow({ where: { userId: ids.a } });
    await provider.declineToken(card.token);
    const MARCH_1 = new Date("2027-03-01T05:00:00Z");
    await shiftBill.runMonthlyShiftBilling({ provider, trigger: "test", now: MARCH_1 });
    const march = await prisma.shiftCharge.findUniqueOrThrow({ where: { shiftId_month: { shiftId, month: "2027-03" } } });
    assert.equal(march.status, "FAILED");

    // בתקופת חסד
    const o1 = await overview.getFinanceOverview({}, true, new Date("2027-03-02T05:00:00Z"));
    assert.equal(o1.shifts!.failedChargesCount, 1);
    assert.equal(o1.shifts!.failedChargesAgorot, march.amountAgorot);
    assert.equal(o1.shifts!.graceShifts, 1);
    assert.equal(o1.shifts!.suspendedShifts, 0);
    assert.equal(o1.outstandingNotCollectedAgorot, march.amountAgorot);
    assert.equal(o1.outstandingBreakdown.bookingDebtsAgorot, 0);
    const sf1 = await overview.getShiftFinance(new Date("2027-03-02T05:00:00Z"));
    assert.equal(sf1.graceShifts[0].id, shiftId);
    assert.equal(sf1.charges[0].shiftId, shiftId);

    // אחרי 7 ימים: מושעית, והמשבצות נשמרות
    await shiftBill.runMonthlyShiftBilling({ provider, trigger: "test", now: new Date("2027-03-09T05:00:00Z") });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "SUSPENDED");
    const o2 = await overview.getFinanceOverview({}, true, new Date("2027-03-09T06:00:00Z"));
    assert.equal(o2.shifts!.suspendedShifts, 1);
    assert.equal((await overview.getShiftFinance(new Date("2027-03-09T06:00:00Z"))).suspendedShifts[0].id, shiftId);
    assert.ok((await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } })) > 0);
    // חוב משמרת מיוצג רק ב-ShiftCharge: אין Debt על תורים של משמרת
    assert.equal(await prisma.debt.count({ where: { appointment: { shiftOccurrence: { isNot: null } } } }), 0);
    const card2 = await overview.getCustomerFinance(ids.a, true, new Date("2027-03-09T06:00:00Z"));
    assert.equal(card2!.shifts[0].status, "SUSPENDED");
    assert.equal(card2!.debts.length, 0);
    // מודול המשמרות סגור: אין חיובי משמרת בסכומים
    assert.equal((await overview.getFinanceOverview({}, false)).shifts, null);
  });

  test("חיוב משמרת במצב לא ידוע: הכרעה דורשת אימות או אסמכתה, ומתועדת", async () => {
    const { shiftId } = await shiftWorld();
    MockPaymentProvider.prototype.chargeSavedMethod = async () => {
      throw new Error("timeout");
    };
    await shiftBill.runMonthlyShiftBilling({ provider, trigger: "test", now: new Date("2027-03-01T05:00:00Z") });
    const charge = await prisma.shiftCharge.findUniqueOrThrow({ where: { shiftId_month: { shiftId, month: "2027-03" } } });
    assert.equal(charge.status, "UNKNOWN");
    const q = await unknown.listUnknown(new Date("2027-03-01T06:00:00Z"), true);
    assert.equal(q.shiftCharges[0].id, charge.id);
    await rejects(unknown.resolveShiftChargeUnknown({ chargeId: charge.id, adminId: ids.admin, provider, outcome: "NOT_CHARGED" }), "INVALID");
    const done = await unknown.resolveShiftChargeUnknown({ chargeId: charge.id, adminId: ids.admin, provider, outcome: "NOT_CHARGED", evidence: "אין חיוב בדוח הספק" });
    assert.equal(done.status, "FAILED");
    assert.equal(await auditCount("SHIFT_CHARGE_UNKNOWN_RESOLVED", charge.id), 1);
  });

  // ───────────── ביקורת ושער ─────────────

  test("23. יומן ביקורת: נוספות בלבד (עדכון/מחיקה נחסמים במסד), ללא סודות, עם סינון", async () => {
    const debtId = await openDebt();
    await debts.waiveDebt({ debtId, adminId: ids.admin, reason: "בדיקה", clientKey: key() });
    const e = await prisma.auditLog.findFirstOrThrow({ where: { action: "DEBT_WAIVED", entityId: debtId } });
    await assert.rejects(prisma.auditLog.update({ where: { id: e.id }, data: { reason: "שונה" } }));
    await assert.rejects(prisma.auditLog.delete({ where: { id: e.id } }));
    await assert.rejects(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${e.id}`);
    await assert.rejects(prisma.$executeRaw`UPDATE "AuditLog" SET "outcome" = 'x' WHERE id = ${e.id}`);
    assert.equal((await prisma.auditLog.findUniqueOrThrow({ where: { id: e.id } })).reason, "בדיקה");

    const sensitive = await audit.writeAudit(prisma, {
      action: "TEST_SANITIZE",
      adminId: ids.admin,
      entityType: "Test",
      outcome: "ok",
      after: { token: "tok_secret", cardNumber: "4111111111111111", password: "p", pinCode: "1234", idempotencyKey: "k", amountAgorot: 10, note: "visible" },
    });
    assert.deepEqual(sensitive.after, { amountAgorot: 10, note: "visible" });
    const list = await audit.listAudit({ action: "DEBT_WAIVED", userId: ids.a });
    assert.equal(list.length, 1);
    assert.equal(list[0].adminName, "fin admin");
    assert.equal((await audit.listAudit({ from: new Date(Date.now() + DAY) })).length, 0);
  });

  test("כרטיס לקוח כספי מאחד תשלומים, חובות, יתרות, חבילות, בקשות ובקרה, ומוגבל ללקוח אחד", async () => {
    const paid = await paidBooking(ids.a);
    const pkg = await buyPackage(ids.a, 5);
    await pkgs.requestPackageCancellation({ userId: ids.a, packageId: pkg.id });
    await openDebt(ids.a, { start: "13:00" });
    const card = (await overview.getCustomerFinance(ids.a, false))!;
    assert.equal(card.user.id, ids.a);
    assert.ok(card.payments.some((p) => p.id === paid.paymentId));
    assert.equal(card.debts.length, 1);
    assert.equal(card.balance.totalMinutes, 300);
    assert.equal(card.cancellationRequests.length, 1);
    assert.equal(card.blocked, false);
    // שום נתון של לקוח אחר, ולא מנהלים
    assert.ok(card.payments.every((p) => p.id !== undefined));
    const other = (await overview.getCustomerFinance(ids.b, false))!;
    assert.equal(other.payments.length, 0);
    assert.equal(other.debts.length, 0);
    assert.equal(await overview.getCustomerFinance(ids.admin, false), null);
    assert.equal((await overview.searchCustomers("fin a")).every((u) => u.id !== ids.admin), true);
  });

  test("28. דגל סגור כברירת מחדל: אין ספק פיננסי; פתוח רק עם הדגל וספק תקף", () => {
    assert.equal(flag.isFinanceAdminEnabled({}), false);
    assert.equal(flag.isFinanceAdminEnabled({ FINANCE_ADMIN_ENABLED: "false" }), false);
    assert.equal(flag.isFinanceAdminEnabled({ FINANCE_ADMIN_ENABLED: "1" }), false);
    assert.equal(flag.isFinanceAdminEnabled({ FINANCE_ADMIN_ENABLED: "true" }), true);
    assert.equal(gate.getFinanceProvider({}), null);
    assert.equal(gate.getFinanceProvider({ FINANCE_ADMIN_ENABLED: "true", PAYMENT_PROVIDER: "none" }), null);
    const live = { FINANCE_ADMIN_ENABLED: "true", PAYMENT_PROVIDER: "mock", PAYMENT_ENVIRONMENT: "live", PAYMENT_MOCK_ENABLED: "true", PAYMENT_WEBHOOK_SECRET: SECRET, DATABASE_URL: testUrl };
    assert.equal(gate.getFinanceProvider(live), null);
  });
});
