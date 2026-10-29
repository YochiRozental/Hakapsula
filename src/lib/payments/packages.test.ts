import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RoomKey } from "@/generated/prisma/client";

// בדיקות אינטגרציה של חבילות שעות, יתרות ותשלום משולב מול PostgreSQL מקומי ייעודי (נפרד ממסדי הבדיקות האחרים,
// כי הקבצים רצים במקביל וכל אחד מנקה את הנתונים שלו). רצות רק כש-PACKAGES_TEST_DATABASE_URL מוגדר ומצביע על מסד
// מקומי בשם *_test. דוגמה:
//   PACKAGES_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_packages_test npm test
const testUrl = process.env.PACKAGES_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) {
    throw new Error("PACKAGES_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
  }
}

const SECRET = "packages-test-secret-0123456789";
const MIN = 60_000;
const DAY = 24 * 3600_000;

describe("חבילות שעות, יתרות ותשלום משולב: מול PostgreSQL מקומי", { skip: !testUrl && "PACKAGES_TEST_DATABASE_URL לא מוגדר" }, () => {
  type Db = typeof import("@/lib/prisma").prisma;
  let prisma: Db;
  let booking: typeof import("@/lib/booking");
  let svc: typeof import("@/lib/payments/booking-payment");
  let pkgs: typeof import("@/lib/payments/packages");
  let bal: typeof import("@/lib/payments/balances");
  let views: typeof import("@/lib/payments/views");
  let pricing: typeof import("@/lib/payments/pricing");
  let policy: typeof import("@/lib/payments/policy");
  let MockPaymentProvider: typeof import("@/lib/payments/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;

  let provider: InstanceType<typeof MockPaymentProvider>;
  let userA: string;
  let userB: string;
  let pendingUser: string;
  let blockedUser: string;
  let adminId: string;
  let mondayMs: number;

  const slot = (hour: number, minutes = 60) => {
    const startTime = new Date(mondayMs + hour * 3600_000);
    return { startTime, endTime: new Date(startTime.getTime() + minutes * MIN) };
  };

  const newProvider = () => new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));

  async function wipe() {
    await prisma.packageCancellationRequest.deleteMany({});
    await prisma.creditUsage.deleteMany({});
    await prisma.packageUsage.deleteMany({});
    await prisma.credit.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.hoursPackage.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.appointment.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = await import("@/lib/prisma"));
    booking = await import("@/lib/booking");
    svc = await import("@/lib/payments/booking-payment");
    pkgs = await import("@/lib/payments/packages");
    bal = await import("@/lib/payments/balances");
    views = await import("@/lib/payments/views");
    pricing = await import("@/lib/payments/pricing");
    policy = await import("@/lib/payments/policy");
    ({ MockPaymentProvider } = await import("@/lib/payments/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    const { jerusalemParts } = await import("@/lib/opening-hours");

    const d = new Date();
    d.setDate(d.getDate() + 90);
    while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    mondayMs = d.getTime();

    await wipe();
    await prisma.user.deleteMany({ where: { email: { startsWith: "pkg-" } } });
    const mk = (n: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({
        data: { name: `pkg ${n}`, email: `pkg-${n}@test.local`, passwordHash: "x", gender: "MALE", status: "APPROVED", ...extra },
      });
    userA = (await mk("a")).id;
    userB = (await mk("b")).id;
    pendingUser = (await mk("pending", { status: "PENDING" })).id;
    blockedUser = (await mk("blocked", { status: "BLOCKED" })).id;
    adminId = (await mk("admin", { role: "ADMIN" })).id;
  });

  beforeEach(async () => {
    await wipe();
    provider = newProvider();
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { email: { startsWith: "pkg-" } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────

  let keyCounter = 0;
  const nextKey = () => `key-${Date.now()}-${keyCounter++}-abcdefgh`;

  /** רכישה מלאה: פתיחה, תשלום אצל הספק, אימות בשרת */
  async function buy(userId: string, hours: number, clientKey = nextKey()) {
    const started = await pkgs.startPackagePurchase({ userId, hours, clientKey, provider });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    const res = await pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider });
    return { started, res };
  }

  async function seedPackage(userId: string, minutes: number, expiresAt = new Date(Date.now() + 365 * DAY)) {
    return prisma.hoursPackage.create({
      data: { userId, hours: 5, pricePaidAgorot: 19500, minutesTotal: minutes, minutesRemaining: minutes, expiresAt },
    });
  }

  async function seedCredit(userId: string, minutes: number, expiresAt: Date) {
    return prisma.credit.create({ data: { userId, minutesTotal: minutes, minutesRemaining: minutes, expiresAt, reason: "test" } });
  }

  const remaining = async (userId: string) => {
    const [p, c] = await Promise.all([
      prisma.hoursPackage.aggregate({ where: { userId }, _sum: { minutesRemaining: true } }),
      prisma.credit.aggregate({ where: { userId }, _sum: { minutesRemaining: true } }),
    ]);
    return (p._sum.minutesRemaining ?? 0) + (c._sum.minutesRemaining ?? 0);
  };

  const hold = (userId: string, roomKey: RoomKey, hour: number, minutes = 60) =>
    svc.holdRoom({ userId, roomKey, ...slot(hour, minutes), source: "WEB" });

  const confirmFromBalance = (userId: string, appointmentId: string, now?: Date) =>
    svc.confirmBookingFromBalance({ appointmentId, userId, provider, now });

  const apptOf = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });
  const payOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
  const usageOf = (appointmentId: string) =>
    Promise.all([prisma.packageUsage.findMany({ where: { appointmentId } }), prisma.creditUsage.findMany({ where: { appointmentId } })]);

  // ───────────── רכישת חבילות ─────────────

  test("רכישת כל אחת מחמש החבילות: מחיר מהטבלה, דקות, תוקף שנה וקשר לתשלום ולרוכש", async () => {
    for (const option of pricing.HOURS_PACKAGES) {
      const { started, res } = await buy(userA, option.hours);
      assert.equal(res.outcome, "PACKAGE_ACTIVATED");
      assert.equal(started.amountAgorot, option.priceAgorot);

      const pay = await payOf(started.paymentId);
      assert.equal(pay.status, "SUCCEEDED");
      assert.equal(pay.purpose, "PACKAGE");
      assert.equal(pay.amountAgorot, option.priceAgorot);
      assert.equal(pay.environment, "SANDBOX");

      const pkg = await prisma.hoursPackage.findUniqueOrThrow({ where: { paymentId: pay.id } });
      assert.equal(pkg.userId, userA);
      assert.equal(pkg.hours, option.hours);
      assert.equal(pkg.pricePaidAgorot, option.priceAgorot);
      assert.equal(pkg.minutesTotal, option.hours * 60);
      assert.equal(pkg.minutesRemaining, option.hours * 60);
      assert.equal(pkg.expiresAt.getTime(), pricing.packageExpiry(pkg.purchasedAt).getTime());
    }
    assert.equal(await prisma.hoursPackage.count({ where: { userId: userA } }), 5);
    assert.equal(await remaining(userA), (5 + 10 + 20 + 50 + 100) * 60);
  });

  test("תשלום רכישה שנכשל או בוטל או שלא הושלם לא יוצר יתרה", async () => {
    const failed = await pkgs.startPackagePurchase({ userId: userA, hours: 5, clientKey: nextKey(), provider });
    await provider.completeCheckout(failed.providerPaymentId!, "failure");
    assert.equal((await pkgs.finalizePackagePayment({ paymentId: failed.paymentId, provider })).outcome, "PAYMENT_FAILED");

    const cancelled = await pkgs.startPackagePurchase({ userId: userA, hours: 10, clientKey: nextKey(), provider });
    await provider.cancelPayment(cancelled.providerPaymentId!);
    assert.equal((await pkgs.finalizePackagePayment({ paymentId: cancelled.paymentId, provider })).outcome, "PAYMENT_CANCELLED");

    const open = await pkgs.startPackagePurchase({ userId: userA, hours: 20, clientKey: nextKey(), provider });
    assert.equal((await pkgs.finalizePackagePayment({ paymentId: open.paymentId, provider })).outcome, "PENDING");

    assert.equal(await prisma.hoursPackage.count({}), 0);
    assert.equal(await remaining(userA), 0);
  });

  test("רכישה כפולה: אותו מפתח (לחיצה כפולה) הוא תשלום אחד וחבילה אחת, גם במקביל ובהפעלה מחדש", async () => {
    const key = nextKey();
    const starts = await Promise.all(Array.from({ length: 6 }, () => pkgs.startPackagePurchase({ userId: userA, hours: 10, clientKey: key, provider })));
    assert.equal(new Set(starts.map((s) => s.paymentId)).size, 1);
    assert.equal(new Set(starts.map((s) => s.providerPaymentId)).size, 1);
    await provider.completeCheckout(starts[0].providerPaymentId!, "success");

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pkgs.finalizePackagePayment({ paymentId: starts[0].paymentId, provider: i % 2 ? newProvider() : provider }))
    );
    assert.equal(results.filter((r) => r.outcome === "PACKAGE_ACTIVATED").length, 1);
    assert.ok(results.every((r) => r.outcome === "PACKAGE_ACTIVATED" || r.outcome === "ALREADY_ACTIVATED"));
    assert.equal(await prisma.hoursPackage.count({}), 1);
    assert.equal(await prisma.payment.count({ where: { purpose: "PACKAGE" } }), 1);

    // כוונת רכישה חדשה (מפתח חדש) היא רכישה נוספת לגיטימית
    const second = await buy(userA, 10);
    assert.equal(second.res.outcome, "PACKAGE_ACTIVATED");
    assert.equal(await prisma.hoursPackage.count({}), 2);

    // שימוש חוזר במפתח לחבילה אחרת נדחה
    await assert.rejects(() => pkgs.startPackagePurchase({ userId: userA, hours: 20, clientKey: key, provider }), { code: "CONFLICT" });
  });

  test("webhook כפול על רכישה: חבילה אחת", async () => {
    const started = await pkgs.startPackagePurchase({ userId: userA, hours: 5, clientKey: nextKey(), provider });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    const signed = provider.buildWebhook({ eventId: "evt_pkg", type: "payment.updated", providerPaymentId: started.providerPaymentId! });
    const results = await Promise.all(Array.from({ length: 4 }, () => svc.handlePaymentWebhook({ provider, ...signed })));
    assert.ok(results.some((r) => r.outcome === "PROCESSED"));
    assert.equal(await prisma.hoursPackage.count({}), 1);
    assert.equal((await svc.handlePaymentWebhook({ provider, ...signed })).outcome, "DUPLICATE");
  });

  test("רק לקוח מאושר רשאי לרכוש: ממתין, חסום, מנהל ומשתמש לא קיים נדחים בלי ליצור תשלום", async () => {
    for (const userId of [pendingUser, blockedUser, adminId]) {
      await assert.rejects(() => pkgs.startPackagePurchase({ userId, hours: 5, clientKey: nextKey(), provider }), { code: "FORBIDDEN" });
    }
    await assert.rejects(() => pkgs.startPackagePurchase({ userId: "nope", hours: 5, clientKey: nextKey(), provider }), { code: "NOT_FOUND" });
    await assert.rejects(() => pkgs.startPackagePurchase({ userId: userA, hours: 7, clientKey: nextKey(), provider }), { code: "INVALID" });
    await assert.rejects(() => pkgs.startPackagePurchase({ userId: userA, hours: 5, clientKey: "short", provider }), { code: "INVALID" });
    assert.equal(await prisma.payment.count({}), 0);
  });

  test("אי אפשר לעקוף: סכום פגוע לא מפעיל חבילה, ותשלום לא אמיתי לא יוצר יתרה", async () => {
    const started = await pkgs.startPackagePurchase({ userId: userA, hours: 100, clientKey: nextKey(), provider });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    // השורה אצלנו שונתה (למשל 100 שעות ב-195 ₪): לא מפעילים
    await prisma.payment.update({ where: { id: started.paymentId }, data: { amountAgorot: 19500 } });
    assert.equal((await pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider })).outcome, "AMOUNT_MISMATCH");
    assert.equal(await prisma.hoursPackage.count({}), 0);
    await prisma.payment.update({ where: { id: started.paymentId }, data: { amountAgorot: 275600 } });

    // תשלום sandbox לא נפתר מול ספק אחר
    await prisma.payment.update({ where: { id: started.paymentId }, data: { environment: "LIVE" } });
    await assert.rejects(() => pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider }), { code: "INVALID" });
    await prisma.payment.update({ where: { id: started.paymentId }, data: { environment: "SANDBOX" } });

    assert.equal((await pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider })).outcome, "PACKAGE_ACTIVATED");

    // כישלון זמני בין אישור הספק ליצירת החבילה: שום דבר לא אבד וניסיון חוזר משלים
    const s2 = await pkgs.startPackagePurchase({ userId: userA, hours: 5, clientKey: nextKey(), provider });
    await provider.completeCheckout(s2.providerPaymentId!, "success");
    await assert.rejects(
      () => pkgs.finalizePackagePayment({ paymentId: s2.paymentId, provider, beforeApply: async () => { throw new Error("db blip"); } }),
      /db blip/
    );
    assert.equal((await payOf(s2.paymentId)).status, "PENDING");
    const rec = await svc.reconcilePendingPayments({ provider, olderThanMs: 0 });
    assert.deepEqual(rec.errors, []);
    assert.equal(await prisma.hoursPackage.count({ where: { userId: userA } }), 2);
  });

  // ───────────── ניצול יתרות ─────────────

  test("הזמנה מתחילה בהחזקה גם כשהיא מכוסה מהיתרה, ואין ניכוי עד האישור", async () => {
    await seedPackage(userA, 300);
    const h = await hold(userA, "ROOM3", 10);
    assert.equal(h.status, "PENDING_PAYMENT");
    assert.ok(h.holdExpiresAt);
    assert.equal(await remaining(userA), 300, "יצירת החזקה לא מנכה דקות");
    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);

    const quote = await svc.quoteHold({ appointmentId: h.id, userId: userA });
    assert.deepEqual([quote.packageMinutes, quote.cashAgorot, quote.fullyCoveredByBalance], [60, 0, true]);
    assert.equal(await remaining(userA), 300, "הצעת מחיר לא מנכה");
    // תשלום בכסף לא נפתח כשהיתרה מכסה הכול
    await assert.rejects(() => svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider }), { code: "INVALID" });

    const res = await confirmFromBalance(userA, h.id);
    assert.equal(res.outcome, "CONFIRMED");
    const appt = await apptOf(h.id);
    assert.equal(appt.status, "CONFIRMED");
    assert.equal(appt.paymentStatus, "PAID");
    assert.equal(appt.paidFromBalanceMinutes, 60);
    assert.equal(appt.paidCashAgorot, 0);
    assert.equal(appt.holdExpiresAt, null);
    assert.equal(await remaining(userA), 240);
    const [pu] = await usageOf(h.id);
    assert.deepEqual(pu.map((u) => [u.kind, u.minutes]), [["CONSUME", 60]]);
    assert.equal(await prisma.payment.count({}), 0, "לא נוצר תשלום בכסף");
  });

  test("ניצול לפי דקות: ניכויים חלקיים מצטברים", async () => {
    await seedPackage(userA, 300);
    const a = await hold(userA, "ROOM3", 9, 15);
    await confirmFromBalance(userA, a.id);
    assert.equal(await remaining(userA), 285);
    const b = await hold(userA, "ROOM3", 10, 45);
    await confirmFromBalance(userA, b.id);
    assert.equal(await remaining(userA), 240);
    assert.equal(pricing.regularPriceAgorot(15), 1300);
  });

  test("החבילה שפוקעת ראשונה מנוצלת ראשונה (וגם זיכוי שפוקע ראשון)", async () => {
    const late = await seedPackage(userA, 300, new Date(Date.now() + 300 * DAY));
    const soon = await seedPackage(userA, 45, new Date(Date.now() + 30 * DAY));
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: soon.id } })).minutesRemaining, 0);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: late.id } })).minutesRemaining, 285);
    const [pu] = await usageOf(h.id);
    assert.deepEqual(pu.map((u) => u.minutes).sort((x, y) => x - y), [15, 45]);

    // זיכוי שפוקע לפני החבילה מנוצל קודם
    const credit = await seedCredit(userA, 30, new Date(Date.now() + 10 * DAY));
    const h2 = await hold(userA, "ROOM4", 10);
    await confirmFromBalance(userA, h2.id);
    assert.equal((await prisma.credit.findUniqueOrThrow({ where: { id: credit.id } })).minutesRemaining, 0);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: late.id } })).minutesRemaining, 255);
    const [, cu] = await usageOf(h2.id);
    assert.deepEqual(cu.map((u) => [u.kind, u.minutes]), [["CONSUME", 30]]);
  });

  test("חבילה שפג תוקפה אינה ניתנת לניצול", async () => {
    await seedPackage(userA, 600, new Date(Date.now() - 1000));
    const h = await hold(userA, "ROOM3", 10);
    const quote = await svc.quoteHold({ appointmentId: h.id, userId: userA });
    assert.deepEqual([quote.packageMinutes, quote.cashAgorot], [0, 5200]);
    await assert.rejects(() => confirmFromBalance(userA, h.id), { code: "INSUFFICIENT_BALANCE" });
    assert.equal(await remaining(userA), 600);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("יתרה של משתמש אחר אינה ניתנת לשימוש, ואי אפשר לאשר הזמנה של אחר", async () => {
    await seedPackage(userA, 300);
    const hB = await hold(userB, "ROOM3", 10);
    await assert.rejects(() => confirmFromBalance(userB, hB.id), { code: "INSUFFICIENT_BALANCE" });
    const hA = await hold(userA, "ROOM4", 10);
    await assert.rejects(() => confirmFromBalance(userB, hA.id), { code: "NOT_FOUND" });
    assert.equal((await svc.quoteHold({ appointmentId: hB.id, userId: userB })).packageMinutes, 0);
    assert.equal(await remaining(userA), 300);
  });

  test("אישור מיתרה אחרי פקיעת ההחזקה: אין ניכוי ואין אישור", async () => {
    await seedPackage(userA, 300);
    const h = await hold(userA, "ROOM3", 10);
    await assert.rejects(() => confirmFromBalance(userA, h.id, new Date(Date.now() + 11 * MIN)), { code: "EXPIRED" });
    assert.equal(await remaining(userA), 300);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("שתי הזמנות מקבילות על אותה יתרה: רק מה שהיתרה מכסה מאושר, בלי יתרה שלילית ובלי ניכוי כפול", async () => {
    for (let round = 0; round < 6; round++) {
      await wipe();
      await seedPackage(userA, 60);
      const h1 = await hold(userA, "ROOM3", 10);
      const h2 = await hold(userA, "ROOM4", 10);
      const results = await Promise.allSettled([confirmFromBalance(userA, h1.id), confirmFromBalance(userA, h2.id)]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(ok.length, 1, `סבב ${round}`);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, "INSUFFICIENT_BALANCE");
      assert.equal(await remaining(userA), 0);
      const used = await prisma.packageUsage.aggregate({ _sum: { minutes: true }, where: { kind: "CONSUME" } });
      assert.equal(used._sum.minutes, 60);
      assert.equal(await prisma.appointment.count({ where: { status: "CONFIRMED" } }), 1);
    }
    // יתרה מספקת לשתיים: שתיהן מצליחות
    await wipe();
    await seedPackage(userA, 120);
    const a = await hold(userA, "ROOM3", 10);
    const b = await hold(userA, "ROOM4", 10);
    const both = await Promise.allSettled([confirmFromBalance(userA, a.id), confirmFromBalance(userA, b.id)]);
    assert.ok(both.every((r) => r.status === "fulfilled"));
    assert.equal(await remaining(userA), 0);
  });

  test("אישור כפול/מקביל של אותה הזמנה מיתרה מנכה פעם אחת", async () => {
    await seedPackage(userA, 300);
    const h = await hold(userA, "ROOM3", 10);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => confirmFromBalance(userA, h.id)));
    assert.ok(results.every((r) => r.status === "fulfilled"), String(results.map((r) => r.status === "rejected" && r.reason)));
    assert.equal(await remaining(userA), 240);
    const [pu] = await usageOf(h.id);
    assert.equal(pu.length, 1);
  });

  test("אילוצי מסד: אין יתרה שלילית ואין ניצול/החזרה כפולים לאותה הזמנה", async () => {
    const pkg = await seedPackage(userA, 60);
    await assert.rejects(() => prisma.hoursPackage.update({ where: { id: pkg.id }, data: { minutesRemaining: -15 } }), /check|constraint/i);
    await assert.rejects(() => prisma.hoursPackage.update({ where: { id: pkg.id }, data: { minutesRemaining: 75 } }), /check|constraint/i);
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    await assert.rejects(
      () => prisma.packageUsage.create({ data: { packageId: pkg.id, kind: "CONSUME", minutes: 15, appointmentId: h.id } }),
      /Unique|unique/
    );
  });

  // ───────────── תשלום משולב ─────────────

  test("תשלום משולב: 30 דקות מחבילה ו-26 ₪ בכסף, והניכוי רק אחרי שהתשלום אומת", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);
    const quote = await svc.quoteHold({ appointmentId: h.id, userId: userA });
    assert.deepEqual([quote.packageMinutes, quote.cashAgorot, quote.fullyCoveredByBalance], [30, 2600, false]);

    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    assert.equal(started.amountAgorot, 2600);
    assert.equal(started.packageMinutes, 30);
    const pay = await payOf(started.paymentId);
    assert.deepEqual([pay.amountAgorot, pay.packageMinutes], [2600, 30]);
    assert.equal(await remaining(userA), 30, "לפני אימות התשלום לא מנכים");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "PENDING");
    assert.equal(await remaining(userA), 30);

    await provider.completeCheckout(started.providerPaymentId, "success");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "CONFIRMED");

    assert.equal(await remaining(userA), 0);
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.status, appt.paymentStatus, appt.paidFromBalanceMinutes, appt.paidCashAgorot], ["CONFIRMED", "PAID", 30, 2600]);
    const [pu] = await usageOf(h.id);
    assert.deepEqual(pu.map((u) => [u.kind, u.minutes]), [["CONSUME", 30]]);
    // אימות חוזר/כפול לא מנכה שוב
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "ALREADY_CONFIRMED");
    assert.equal(await remaining(userA), 0);
    assert.equal(await prisma.packageUsage.count({}), 1);
  });

  test("תשלום משולב שנכשל: לא מאושרת הזמנה ולא מנוכות דקות; ניסיון חוזר מצליח", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    await provider.completeCheckout(started.providerPaymentId, "failure");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "PAYMENT_FAILED");
    assert.equal(await remaining(userA), 30);
    assert.equal(await prisma.packageUsage.count({}), 0);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    const retry = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    assert.notEqual(retry.paymentId, started.paymentId);
    await provider.completeCheckout(retry.providerPaymentId, "success");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: retry.paymentId, provider })).outcome, "CONFIRMED");
    assert.equal(await remaining(userA), 0);
  });

  test("תשלום משולב שהצליח אחרי פקיעת ההחזקה: החזר כספי, בלי ניכוי דקות ובלי אישור", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    await provider.completeCheckout(started.providerPaymentId, "success");

    const res = await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, now: new Date(Date.now() + 11 * MIN) });
    assert.equal(res.outcome, "LATE_REFUNDED");
    assert.equal(await remaining(userA), 30);
    assert.equal(await prisma.packageUsage.count({}), 0);
    assert.equal((await apptOf(h.id)).status, "CANCELLED");
    const refunds = await prisma.refund.findMany({ where: { paymentId: started.paymentId } });
    assert.deepEqual(refunds.map((r) => [r.status, r.amountAgorot]), [["SUCCEEDED", 2600]]);
  });

  test("אימות תשלום משולב מקביל לאישור מיתרה על אותה יתרה: רק אחד מנצל אותה, והשני לא מאבד כסף", async () => {
    for (let round = 0; round < 6; round++) {
      await wipe();
      provider = newProvider();
      await seedPackage(userA, 30);
      const combined = await hold(userA, "ROOM3", 10, 60); // 30 מהיתרה + 26 ₪
      const started = await svc.startBookingPayment({ appointmentId: combined.id, userId: userA, provider });
      assert.equal(started.packageMinutes, 30);
      await provider.completeCheckout(started.providerPaymentId, "success");
      const other = await hold(userA, "ROOM4", 10, 30); // מכוסה במלואה מאותה יתרה

      const [fin, conf] = await Promise.allSettled([
        svc.finalizeBookingPayment({ paymentId: started.paymentId, provider }),
        confirmFromBalance(userA, other.id),
      ]);
      assert.equal(await remaining(userA), 0, "הכול נוצל פעם אחת");
      const used = await prisma.packageUsage.aggregate({ _sum: { minutes: true }, where: { kind: "CONSUME" } });
      assert.equal(used._sum.minutes, 30, `סבב ${round}: ניכוי יחיד`);
      assert.equal(fin.status, "fulfilled");
      const combinedWon = (fin as PromiseFulfilledResult<{ outcome: string }>).value.outcome === "CONFIRMED";
      if (combinedWon) {
        assert.equal(conf.status, "rejected");
        assert.equal((conf as PromiseRejectedResult).reason.code, "INSUFFICIENT_BALANCE");
        assert.equal((await apptOf(other.id)).status, "PENDING_PAYMENT");
        assert.equal(await prisma.refund.count({}), 0);
      } else {
        assert.equal((fin as PromiseFulfilledResult<{ outcome: string }>).value.outcome, "BALANCE_CHANGED_REFUNDED");
        assert.equal(conf.status, "fulfilled");
        assert.equal((await apptOf(combined.id)).status, "CANCELLED");
        assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 2600);
      }
    }
  });

  test("שינוי יתרה בזמן התשלום: הכסף מוחזר, ההזמנה מבוטלת, בלי ניכוי חלקי ובלי יתרה שלילית", async () => {
    await seedPackage(userA, 30);
    const combined = await hold(userA, "ROOM3", 10, 60); // 30 מהיתרה + 26 ₪
    const started = await svc.startBookingPayment({ appointmentId: combined.id, userId: userA, provider });
    assert.equal(started.packageMinutes, 30);

    // בזמן שהלקוח במסך התשלום, הזמנה אחרת מנצלת את כל היתרה
    const other = await hold(userA, "ROOM4", 10, 30);
    assert.equal((await confirmFromBalance(userA, other.id)).outcome, "CONFIRMED");
    assert.equal(await remaining(userA), 0);

    await provider.completeCheckout(started.providerPaymentId, "success");
    const res = await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    assert.equal(res.outcome, "BALANCE_CHANGED_REFUNDED");
    assert.equal(await remaining(userA), 0, "לא נוצרה יתרה שלילית");
    assert.equal((await apptOf(combined.id)).status, "CANCELLED");
    assert.equal((await apptOf(other.id)).status, "CONFIRMED");
    assert.equal(await prisma.packageUsage.count({ where: { appointmentId: combined.id } }), 0);
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: started.paymentId } });
    assert.deepEqual([refund.status, refund.amountAgorot], ["SUCCEEDED", 2600]);
  });

  test("שינוי יתרה לפני התשלום: התוכנית מתעדכנת, התשלום הישן מבוטל ונפתח חדש בסכום הנכון", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10, 60);
    const first = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    assert.deepEqual([first.amountAgorot, first.packageMinutes], [2600, 30]);

    const other = await hold(userA, "ROOM4", 10, 30);
    await confirmFromBalance(userA, other.id);

    const second = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    assert.notEqual(second.paymentId, first.paymentId);
    assert.deepEqual([second.amountAgorot, second.packageMinutes], [5200, 0]);
    assert.equal((await payOf(first.paymentId)).status, "CANCELLED");
    assert.equal((await provider.getPaymentStatus(first.providerPaymentId)).status, "CANCELLED");
    assert.equal(await prisma.payment.count({ where: { appointmentId: h.id, status: "PENDING" } }), 1);

    await provider.completeCheckout(second.providerPaymentId, "success");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: second.paymentId, provider })).outcome, "CONFIRMED");
    assert.equal((await apptOf(h.id)).paidFromBalanceMinutes, 0);
  });

  test("מעבר מתשלום בכסף לתשלום מיתרה מבטל את התשלום הממתין", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10, 30); // מכוסה במלואה
    // לקוח בלי שימוש ביתרה פותח תשלום בכסף, ואז עובר ליתרה
    const cash = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider, useBalance: false });
    assert.equal(cash.amountAgorot, 2600);
    await confirmFromBalance(userA, h.id);
    assert.equal((await payOf(cash.paymentId)).status, "CANCELLED");
    assert.equal(await remaining(userA), 0);
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");
  });

  // ───────────── ביטולים והחזרת דקות ─────────────

  test("ביטול 24 שעות ומעלה מחזיר את הדקות לחבילה המקורית (בדיוק 24 שעות מזכה), בלי כפילות", async () => {
    const pkg = await seedPackage(userA, 300);
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    assert.equal(await remaining(userA), 240);

    const exactly24h = new Date(h.startTime.getTime() - 24 * 3600_000);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: exactly24h });
    assert.equal(res.outcome, "MINUTES_RESTORED");
    assert.deepEqual([res.minutesRestored, res.creditedMinutes], [60, 0]);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 300);
    const [pu] = await usageOf(h.id);
    assert.deepEqual(pu.map((u) => u.kind).sort(), ["CONSUME", "RESTORE"]);
    assert.equal(await prisma.credit.count({}), 0);

    // החזר כפול נמנע: ביטול חוזר, אישור חריג ואפילו קריאה ישירה לא מחזירים שוב
    assert.equal((await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider })).outcome, "ALREADY_CANCELLED");
    const approvedAgain = await svc.approveCancellationRefund({ appointmentId: h.id, adminId, provider, now: exactly24h });
    assert.equal(approvedAgain.minutesRestored, 0);
    const again = await prisma.$transaction(async (tx) => {
      const { lockUserBalances } = await import("@/lib/payments/shared");
      await lockUserBalances(tx, userA);
      return bal.restoreAppointmentBalance(tx, { userId: userA, appointmentId: h.id, now: exactly24h });
    });
    assert.deepEqual([again.restoredMinutes, again.creditedMinutes], [0, 0]);
    assert.equal(await remaining(userA), 300);
    await assert.rejects(
      () => prisma.packageUsage.create({ data: { packageId: pkg.id, kind: "RESTORE", minutes: 60, appointmentId: h.id } }),
      /Unique|unique/
    );
  });

  test("ביטול הזמנה משולבת: הדקות חוזרות והכסף מוחזר, כל אחד בנפרד ופעם אחת", async () => {
    const pkg = await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    assert.equal(await remaining(userA), 0);

    const early = new Date(h.startTime.getTime() - 48 * 3600_000);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: early });
    assert.equal(res.outcome, "REFUNDED");
    assert.equal(res.minutesRestored, 30);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 30);
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 2600);
    assert.equal(await prisma.refund.count({ where: { paymentId: started.paymentId } }), 1);
    assert.equal((await apptOf(h.id)).paymentStatus, "REFUNDED");
  });

  test("ביטול אחרי שהחבילה פגה: זיכוי נפרד ל-30 יום מהביטול, בלי להאריך את החבילה; הזיכוי מנוצל לפני תשלום", async () => {
    const pkg = await seedPackage(userA, 300, new Date(Date.now() + 30 * DAY));
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);

    // הביטול מתבצע אחרי שהחבילה פגה (כ-88 ימים קדימה)
    const cancelAt = new Date(h.startTime.getTime() - 48 * 3600_000);
    assert.ok(cancelAt.getTime() > pkg.expiresAt.getTime());
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: cancelAt });
    assert.equal(res.outcome, "MINUTES_RESTORED");
    assert.deepEqual([res.minutesRestored, res.creditedMinutes], [0, 60]);

    const after = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(after.minutesRemaining, 240, "החבילה שפגה לא מקבלת דקות");
    assert.equal(after.expiresAt.getTime(), pkg.expiresAt.getTime(), "התוקף לא הואר");

    const credit = await prisma.credit.findFirstOrThrow({ where: { userId: userA } });
    assert.equal(credit.minutesTotal, 60);
    assert.equal(credit.minutesRemaining, 60);
    assert.equal(credit.expiresAt.getTime(), policy.creditExpiry(cancelAt).getTime());
    assert.equal(credit.expiresAt.getTime() - cancelAt.getTime(), 30 * DAY);
    assert.equal(credit.sourceAppointmentId, h.id);
    const restore = await prisma.packageUsage.findFirstOrThrow({ where: { appointmentId: h.id, kind: "RESTORE" } });
    assert.equal(restore.convertedToCreditId, credit.id);

    // הזיכוי ניתן לניצול לפני תשלום רגיל
    const sources = await bal.loadUsableBalances(prisma, userA, cancelAt);
    const split = pricing.splitBookingPrice(60, sources.map(bal.toPackageBalance), cancelAt);
    assert.deepEqual([split.packageMinutes, split.regularPriceAgorot], [60, 0]);
  });

  test("ביטול בפחות מ-24 שעות: בלי החזר דקות או כסף; אישור חריג מנהל מחזיר פעם אחת", async () => {
    const pkg = await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });

    const late = new Date(h.startTime.getTime() - 23 * 3600_000);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: late });
    assert.equal(res.outcome, "CANCELLED_NO_REFUND");
    assert.equal(res.minutesRestored, 0);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 0);
    assert.equal(await prisma.refund.count({}), 0);

    await assert.rejects(() => svc.approveCancellationRefund({ appointmentId: h.id, adminId: userB, provider }), { code: "FORBIDDEN" });
    const approved = await svc.approveCancellationRefund({ appointmentId: h.id, adminId, provider, now: late });
    assert.equal(approved.minutesRestored, 30);
    assert.equal(approved.refund?.amountAgorot, 2600);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 30);

    const second = await svc.approveCancellationRefund({ appointmentId: h.id, adminId, provider, now: late });
    assert.equal(second.minutesRestored, 0);
    assert.equal(await prisma.refund.count({}), 1);
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 2600);
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 30);
  });

  test("חריג מנהל בביטול: מנהל יכול להחזיר גם בביטול מאוחר, לקוח לא יכול להעניק לעצמו חריג", async () => {
    const pkg = await seedPackage(userA, 60);
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    const late = new Date(h.startTime.getTime() - 2 * 3600_000);

    const own = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: late, adminException: true });
    assert.equal(own.outcome, "CANCELLED_NO_REFUND", "adminException מתעלמים ממנו כשהמבקש אינו מנהל");
    assert.equal((await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } })).minutesRemaining, 0);

    const h3 = await hold(userB, "ROOM3", 12);
    await seedPackage(userB, 60);
    await confirmFromBalance(userB, h3.id);
    const byAdmin = await svc.cancelBooking({ appointmentId: h3.id, requester: { id: adminId, role: "ADMIN" }, provider, now: new Date(h3.startTime.getTime() - 3600_000), adminException: true });
    assert.equal(byAdmin.outcome, "MINUTES_RESTORED");
    assert.equal(await remaining(userB), 60);
  });

  test("הזמנה מיתרה מבוטלת רק דרך מסלול הביטול עם החזרה, לא דרך המסלול הישן", async () => {
    await seedPackage(userA, 300);
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    await assert.rejects(() => booking.cancelAppointment(h.id, { id: userA, role: "CLIENT" }), /החזר/);
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");
    assert.equal(await remaining(userA), 240);
  });

  // ───────────── חובות והזמנות מנהל ─────────────

  test("ביטול הזמנת מנהל עם חוב: מוקדם מבטל את החוב, מאוחר משאיר אותו, וחריג מנהל מוותר עליו", async () => {
    const mk = (hour: number) => svc.createAdminBookingWithDebt({ adminId, userId: userA, roomKey: "ROOM3", ...slot(hour) });

    const early = await mk(10);
    assert.equal(early.debt?.amountAgorot, 5200);
    const e = await svc.cancelBooking({
      appointmentId: early.appointment.id,
      requester: { id: userA, role: "CLIENT" },
      provider,
      now: new Date(early.appointment.startTime.getTime() - 24 * 3600_000),
    });
    assert.equal(e.outcome, "CANCELLED_NO_PAYMENT");
    assert.equal(e.debtWaived, true);
    const waived = await prisma.debt.findUniqueOrThrow({ where: { appointmentId: early.appointment.id } });
    assert.equal(waived.status, "WAIVED");
    assert.ok(waived.resolvedAt);

    const lateBooking = await mk(11);
    const l = await svc.cancelBooking({
      appointmentId: lateBooking.appointment.id,
      requester: { id: userA, role: "CLIENT" },
      provider,
      now: new Date(lateBooking.appointment.startTime.getTime() - 23 * 3600_000),
    });
    assert.equal(l.debtWaived, false);
    assert.equal((await prisma.debt.findUniqueOrThrow({ where: { appointmentId: lateBooking.appointment.id } })).status, "OPEN");

    // אישור חריג בלי ויתור על חוב: החוב נשאר; עם ויתור: מבוטל
    await assert.rejects(
      () => svc.approveCancellationRefund({ appointmentId: lateBooking.appointment.id, adminId, provider }),
      { code: "NOT_FOUND" }
    );
    const approved = await svc.approveCancellationRefund({ appointmentId: lateBooking.appointment.id, adminId, provider, waiveDebt: true });
    assert.equal(approved.debtWaived, true);
    const resolved = await prisma.debt.findUniqueOrThrow({ where: { appointmentId: lateBooking.appointment.id } });
    assert.deepEqual([resolved.status, resolved.resolvedById], ["WAIVED", adminId]);

    // חוב ששולם לא משתנה בביטול
    const third = await mk(12);
    const thirdDebt = await prisma.debt.findUniqueOrThrow({ where: { appointmentId: third.appointment.id } });
    await prisma.debt.update({ where: { appointmentId: third.appointment.id }, data: { status: "PAID", paidAgorot: thirdDebt.amountAgorot } });
    await svc.cancelBooking({ appointmentId: third.appointment.id, requester: { id: adminId, role: "ADMIN" }, provider, now: new Date(third.appointment.startTime.getTime() - 48 * 3600_000) });
    assert.equal((await prisma.debt.findUniqueOrThrow({ where: { appointmentId: third.appointment.id } })).status, "PAID");
  });

  test("חוב פתוח אינו חוסם הזמנות חדשות של הלקוח", async () => {
    await svc.createAdminBookingWithDebt({ adminId, userId: userA, roomKey: "ROOM3", ...slot(10) });
    const h = await hold(userA, "ROOM4", 10);
    assert.equal(h.status, "PENDING_PAYMENT");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userA } })).status, "APPROVED");
  });

  // ───────────── רגרסיה ─────────────

  test("רגרסיה: createAppointment ממשיך לאשר מיד גם ללקוח עם יתרה, ולא נוגע בה", async () => {
    await seedPackage(userA, 300);
    const appt = await booking.createAppointment({ userId: userA, roomKey: "ROOM3", ...slot(10), source: "WEB" });
    assert.equal(appt.status, "CONFIRMED");
    assert.equal(appt.paymentStatus, "NOT_REQUIRED");
    assert.equal(appt.paidFromBalanceMinutes, 0);
    assert.equal(await remaining(userA), 300);
    assert.equal(await prisma.packageUsage.count({}), 0);
    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);
    const cancelled = await booking.cancelAppointment(appt.id, { id: userA, role: "CLIENT" });
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(await remaining(userA), 300);
  });

  test("מקביליות: 8 אישורים מיתרה לאותו חדר ושעה, בדיוק אחד מצליח וניכוי יחיד", async () => {
    await seedPackage(userA, 600);
    await seedPackage(userB, 600);
    const holdA = await hold(userA, "ROOM3", 10);
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => confirmFromBalance(userA, holdA.id)),
      ...Array.from({ length: 4 }, () => hold(userB, "ROOM3", 10)),
    ]);
    assert.equal(results.slice(4).filter((r) => r.status === "fulfilled").length, 0, "החזקה פעילה חוסמת");
    assert.equal(await remaining(userA), 540);
    assert.equal(await remaining(userB), 600);
  });

  // ───────────── שלב E: בקשות ביטול חבילה ─────────────

  test("בקשת ביטול חבילה: נרשמת על שם המשתמש, לא מבטלת ולא מחזירה כסף, ולא משנה את החבילה", async () => {
    const pkg = await seedPackage(userA, 300);
    const before = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    const res = await pkgs.requestPackageCancellation({ userId: userA, packageId: pkg.id, reason: "  שינוי תוכניות  " });
    assert.equal(res.status, "PENDING");

    const row = await prisma.packageCancellationRequest.findUniqueOrThrow({ where: { id: res.id } });
    assert.deepEqual([row.userId, row.packageId, row.reason, row.status], [userA, pkg.id, "שינוי תוכניות", "PENDING"]);
    assert.ok(row.createdAt);
    assert.equal(row.decidedAt, null);

    const after = await prisma.hoursPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.deepEqual(
      [after.minutesRemaining, after.minutesTotal, after.expiresAt.getTime()],
      [before.minutesRemaining, before.minutesTotal, before.expiresAt.getTime()]
    );
    assert.equal(await prisma.refund.count({}), 0);
    // החבילה נשארת בשימוש עד להחלטת מנהל
    const h = await hold(userA, "ROOM3", 10);
    assert.equal((await confirmFromBalance(userA, h.id)).outcome, "CONFIRMED");
    assert.equal(await remaining(userA), 240);

    const view = await views.getBalanceView(userA);
    assert.equal(view.packages[0].cancellationRequest?.status, "PENDING");
  });

  test("בקשת ביטול כפולה: רק בקשה פתוחה אחת לחבילה, גם במקביל; אחרי דחייה אפשר שוב, אחרי אישור לא", async () => {
    const pkg = await seedPackage(userA, 300);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => pkgs.requestPackageCancellation({ userId: userA, packageId: pkg.id }))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.ok(rejected.every((r) => r.reason.code === "CONFLICT"));
    assert.equal(await prisma.packageCancellationRequest.count({}), 1);

    await prisma.packageCancellationRequest.updateMany({ data: { status: "REJECTED", decidedAt: new Date(), decidedById: adminId } });
    const again = await pkgs.requestPackageCancellation({ userId: userA, packageId: pkg.id });
    assert.equal(again.status, "PENDING");
    assert.equal(await prisma.packageCancellationRequest.count({}), 2);

    await prisma.packageCancellationRequest.updateMany({ where: { status: "PENDING" }, data: { status: "APPROVED" } });
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: userA, packageId: pkg.id }), { code: "CONFLICT" });
  });

  test("בקשת ביטול: חבילה של אחר, מנהל, חבילה שפגה/נוצלה, וסיבה ארוכה", async () => {
    const pkgA = await seedPackage(userA, 300);
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: userB, packageId: pkgA.id }), { code: "NOT_FOUND" });
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: adminId, packageId: pkgA.id }), { code: "FORBIDDEN" });
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: userA, packageId: "nope" }), { code: "NOT_FOUND" });
    const expired = await seedPackage(userA, 300, new Date(Date.now() - 1000));
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: userA, packageId: expired.id }), { code: "INVALID" });
    const empty = await seedPackage(userA, 0);
    await assert.rejects(() => pkgs.requestPackageCancellation({ userId: userA, packageId: empty.id }), { code: "INVALID" });

    const long = await pkgs.requestPackageCancellation({ userId: userA, packageId: pkgA.id, reason: "א".repeat(900) });
    assert.equal((await prisma.packageCancellationRequest.findUniqueOrThrow({ where: { id: long.id } })).reason?.length, 500);
    assert.equal(await prisma.packageCancellationRequest.count({ where: { userId: { not: userA } } }), 0);
  });

  // ───────────── שלב E: תצוגות (יתרה, החזקה, היסטוריה) ─────────────

  test("תצוגת יתרה: סכום מחושב בשרת, חבילות שפג תוקפן בנפרד, זיכויים, ורק נתוני המשתמש", async () => {
    await seedPackage(userA, 300, new Date(Date.now() + 100 * DAY));
    await seedPackage(userA, 120, new Date(Date.now() + 10 * DAY));
    await seedPackage(userA, 0, new Date(Date.now() + 50 * DAY)); // נוצלה במלואה
    const expired = await seedPackage(userA, 90, new Date(Date.now() - DAY)); // פגה עם יתרה שלא נוצלה
    await seedCredit(userA, 30, new Date(Date.now() + 20 * DAY));
    await seedCredit(userA, 45, new Date(Date.now() - DAY)); // זיכוי שפג
    await seedPackage(userB, 999);

    const v = await views.getBalanceView(userA);
    assert.equal(v.totalMinutes, 300 + 120 + 30, "החבילה שפגה והזיכוי שפג אינם ביתרה");
    assert.deepEqual(v.packages.map((p) => p.minutesRemaining), [120, 300], "לפי סדר הניצול: הפוקעת ראשונה קודם");
    assert.equal(v.exhaustedPackages.length, 1);
    assert.deepEqual(v.expiredPackages.map((p) => [p.id, p.minutesRemaining]), [[expired.id, 90]]);
    assert.deepEqual([v.credits.length, v.expiredCredits.length], [1, 1]);
    assert.ok(v.packages.every((p) => p.pricePaidAgorot > 0 && p.purchasedAt && p.expiresAt));
    assert.equal((await views.getBalanceView(userB)).totalMinutes, 999);
  });

  test("פרטי החזקה: זמן פקיעה מהשרת, חלוקת תשלום, הרשאות, והמצב אחרי פקיעה ואחרי אישור", async () => {
    await seedPackage(userA, 30);
    const h = await hold(userA, "ROOM3", 10);

    const d = await views.getHoldDetails(h.id, userA);
    assert.equal(d.holdActive, true);
    assert.equal(d.holdExpiresAt, h.holdExpiresAt!.toISOString());
    assert.ok(Math.abs(Date.parse(d.serverNow) - Date.now()) < 5000);
    assert.deepEqual([d.fullPriceAgorot, d.availableBalanceMinutes, d.durationMinutes], [5200, 30, 60]);
    assert.deepEqual(d.plan, { packageMinutes: 30, cashAgorot: 2600, fullyCoveredByBalance: false });
    assert.equal(d.payment, null);

    await assert.rejects(() => views.getHoldDetails(h.id, userB), { code: "NOT_FOUND" });
    await assert.rejects(() => views.getHoldDetails("nope", userA), { code: "NOT_FOUND" });

    // אחרי פקיעה (לפי השרת): אין החזקה פעילה ואין תוכנית תשלום
    const expired = await views.getHoldDetails(h.id, userA, new Date(Date.now() + 11 * MIN));
    assert.deepEqual([expired.holdActive, expired.holdExpiresAt, expired.plan], [false, null, null]);

    // תשלום משולב שהסתיים באישור: החלוקה מוצגת מהשרת
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    const pending = await views.getHoldDetails(h.id, userA);
    assert.deepEqual([pending.payment?.status, pending.payment?.amountAgorot, pending.payment?.packageMinutes], ["PENDING", 2600, 30]);
    assert.equal(pending.payment?.providerPaymentId, started.providerPaymentId);
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    const done = await views.getHoldDetails(h.id, userA);
    assert.deepEqual([done.status, done.paidFromBalanceMinutes, done.paidCashAgorot, done.holdActive], ["CONFIRMED", 30, 2600, false]);
  });

  test("פרטי החזקה אחרי תשלום מאוחר: ההחזר מופיע ולא מוסתר", async () => {
    const h = await hold(userA, "ROOM3", 10);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, now: new Date(Date.now() + 11 * MIN) });
    const d = await views.getHoldDetails(h.id, userA);
    assert.equal(d.status, "CANCELLED");
    assert.deepEqual([d.payment?.status, d.payment?.refundedAgorot], ["SUCCEEDED", 5200]);
  });

  test("היסטוריה: רכישות, תשלומים, ניצול, החזרת דקות, זיכויים והחזרים של המשתמש בלבד", async () => {
    await buy(userA, 5);
    await buy(userB, 10);
    const h = await hold(userA, "ROOM3", 10);
    await confirmFromBalance(userA, h.id);
    await svc.cancelBooking({
      appointmentId: h.id,
      requester: { id: userA, role: "CLIENT" },
      provider,
      now: new Date(h.startTime.getTime() - 48 * 3600_000),
    });
    // תשלום בכסף שהוחזר
    const h2 = await hold(userA, "ROOM4", 10);
    const s2 = await svc.startBookingPayment({ appointmentId: h2.id, userId: userA, provider, useBalance: false });
    await provider.completeCheckout(s2.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: s2.paymentId, provider, now: new Date(Date.now() + 11 * MIN) });
    await seedCredit(userA, 60, new Date(Date.now() + 25 * DAY));

    const entries = await views.getPaymentHistory(userA);
    const kinds = new Set(entries.map((e) => e.kind));
    for (const k of ["PACKAGE_PURCHASE", "BOOKING_PAYMENT", "MINUTES_USED", "MINUTES_RESTORED", "CREDIT_GRANTED", "REFUND"]) {
      assert.ok(kinds.has(k as never), `חסר ${k}`);
    }
    const purchase = entries.find((e) => e.kind === "PACKAGE_PURCHASE")!;
    assert.deepEqual([purchase.hours, purchase.amountAgorot, purchase.status], [5, 19500, "SUCCEEDED"]);
    assert.equal(entries.find((e) => e.kind === "REFUND")?.amountAgorot, 5200);
    assert.equal(entries.find((e) => e.kind === "MINUTES_USED")?.minutes, 60);
    assert.ok(entries.every((e, i) => i === 0 || entries[i - 1].at >= e.at), "ממוין מהחדש לישן");

    // בידוד: משתמש אחר רואה רק את שלו
    const forB = await views.getPaymentHistory(userB);
    assert.ok(forB.every((e) => e.kind === "PACKAGE_PURCHASE" && e.hours === 10));
    assert.equal(forB.length, 1);
    assert.equal((await views.getPaymentHistory(pendingUser)).length, 0);
  });
});
