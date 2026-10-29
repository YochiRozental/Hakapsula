import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RoomKey } from "@/generated/prisma/client";

// בדיקות אינטגרציה מול PostgreSQL מקומי ייעודי (נפרד ממסד בדיקות המקביליות הקיים, שמוחק את כל ההזמנות).
// רצות רק כש-PAYMENTS_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test. דוגמה:
//   PAYMENTS_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_payments_test npm test
const testUrl = process.env.PAYMENTS_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) {
    throw new Error("PAYMENTS_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
  }
}

const SECRET = "integration-test-secret-0123456789";
const MIN = 60_000;

describe("תשלום על הזמנה והחזקת חדרים: מול PostgreSQL מקומי", { skip: !testUrl && "PAYMENTS_TEST_DATABASE_URL לא מוגדר" }, () => {
  type Db = typeof import("@/lib/prisma").prisma;
  let prisma: Db;
  let booking: typeof import("@/lib/booking");
  let svc: typeof import("@/lib/payments/booking-payment");
  let MockPaymentProvider: typeof import("@/lib/payments/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let WebhookVerificationError: typeof import("@/lib/payments/provider").WebhookVerificationError;

  let provider: InstanceType<typeof MockPaymentProvider>;
  let userA: string;
  let userB: string;
  let adminId: string;
  let mondayMs: number;

  /** שעה אחת בשעה נתונה (UTC) ביום שני בעוד ~90 יום: בתוך שעות הפעילות של ירושלים */
  const slot = (hour: number) => {
    const startTime = new Date(mondayMs + hour * 3600_000);
    return { startTime, endTime: new Date(startTime.getTime() + 3600_000) };
  };

  const newProvider = () => new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));

  async function wipe() {
    await prisma.refund.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
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
    ({ MockPaymentProvider } = await import("@/lib/payments/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    ({ WebhookVerificationError } = await import("@/lib/payments/provider"));
    const { jerusalemParts } = await import("@/lib/opening-hours");

    const d = new Date();
    d.setDate(d.getDate() + 90);
    while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    mondayMs = d.getTime();

    await wipe();
    await prisma.user.deleteMany({ where: { email: { startsWith: "pay-" } } });
    const mk = (n: string, role: "CLIENT" | "ADMIN" = "CLIENT") =>
      prisma.user.create({
        data: { name: `pay ${n}`, email: `pay-${n}@test.local`, passwordHash: "x", gender: "MALE", status: "APPROVED", role },
      });
    userA = (await mk("a")).id;
    userB = (await mk("b")).id;
    adminId = (await mk("admin", "ADMIN")).id;
  });

  beforeEach(async () => {
    await wipe();
    provider = newProvider();
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { email: { startsWith: "pay-" } } });
    await prisma.$disconnect();
  });

  const hold = (userId: string, roomKey: RoomKey, hour: number, extra: { now?: Date } = {}) =>
    svc.holdRoom({ userId, roomKey, ...slot(hour), source: "WEB", ...extra });

  /** מסלול מלא עד תשלום ממתין אצל הספק */
  async function holdAndStart(userId: string, roomKey: RoomKey, hour: number) {
    const h = await hold(userId, roomKey, hour);
    const started = await svc.startBookingPayment({ appointmentId: h.id, userId, provider });
    return { hold: h, started };
  }

  const apptOf = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });
  const payOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

  // ───────────── החזקות ─────────────

  test("החזקה פעילה חוסמת הזמנה מתחרה (החזקה אחרת והזמנה רגילה), ונמשכת 10 דקות", async () => {
    const before = Date.now();
    const h = await hold(userA, "ROOM3", 10);
    assert.equal(h.status, "PENDING_PAYMENT");
    assert.equal(h.paymentStatus, "UNPAID");
    const ttl = h.holdExpiresAt!.getTime() - before;
    assert.ok(ttl >= 10 * MIN - 2000 && ttl <= 10 * MIN + 5000, `ttl=${ttl}`);

    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);
    await assert.rejects(
      () => booking.createAppointment({ userId: userB, roomKey: "ROOM3", ...slot(10), source: "WEB" }),
      booking.BookingError
    );
    // חדר משולב מתנגש עם חדר 1 גם דרך החזקה
    await hold(userA, "ROOM1", 11);
    await assert.rejects(() => hold(userB, "ROOM1_2", 11), booking.BookingError);
    // חדר אחר באותה שעה פנוי
    await hold(userB, "ROOM4", 10);
  });

  test("החזקה שפגה משחררת את החדר גם בלי שהניקוי רץ", async () => {
    const h = await hold(userA, "ROOM3", 10);
    // פקיעה בפועל: מקדמים את תאריך הפקיעה לעבר, בלי להפעיל שום ניקוי
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    const day = await prisma.appointment.findMany({ where: booking.blockingAppointmentWhere(new Date()) });
    assert.equal(day.length, 0, "החזקה שפגה לא נספרת כחוסמת");

    const legacy = await booking.createAppointment({ userId: userB, roomKey: "ROOM3", ...slot(10), source: "WEB" });
    assert.equal(legacy.status, "CONFIRMED");
  });

  test("מקביליות: 12 החזקות לאותו חדר ושעה, בדיוק אחת מצליחה", async () => {
    for (let round = 0; round < 3; round++) {
      await wipe();
      const users = [userA, userB, adminId];
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => svc.holdRoom({ userId: users[i % 3], roomKey: "ROOM3", ...slot(10), source: i % 3 === 2 ? "ADMIN" : "WEB" }))
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const unexpected = results.filter((r) => r.status === "rejected" && !(r.reason instanceof booking.BookingError));
      // userA ו-userB מבקשים כל אחד 4 פעמים: אותו משתמש בדיוק על אותו טווח מקבל את אותה החזקה (אידמפוטנטי)
      const ids = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
      assert.equal(unexpected.length, 0, String(unexpected.map((r) => (r as PromiseRejectedResult).reason)));
      assert.equal(ids.size, 1, `סבב ${round}: החזקה אחת בלבד`);
      assert.equal(await prisma.appointment.count({ where: { status: "PENDING_PAYMENT" } }), 1);
    }
  });

  test("מקביליות: ROOM1 מול ROOM1_2 וההזמנה הרגילה, לעולם לא חפיפה", async () => {
    for (let round = 0; round < 10; round++) {
      await wipe();
      const results = await Promise.allSettled([
        svc.holdRoom({ userId: userA, roomKey: "ROOM1", ...slot(12), source: "WEB" }),
        svc.holdRoom({ userId: userB, roomKey: "ROOM1_2", ...slot(12), source: "WEB" }),
        booking.createAppointment({ userId: adminId, roomKey: "ROOM2", ...slot(12), source: "ADMIN" }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const other = results.filter((r) => r.status === "rejected" && !(r.reason instanceof booking.BookingError));
      assert.equal(other.length, 0);
      // ROOM1 ו-ROOM2 אינם מתנגשים זה בזה, אך ROOM1_2 מתנגש בשניהם: או {1,2} או {1_2}
      const rows = await prisma.appointment.findMany({ include: { room: true } });
      const keys = rows.map((r) => r.room.key).sort();
      assert.ok(
        JSON.stringify(keys) === JSON.stringify(["ROOM1", "ROOM2"]) || JSON.stringify(keys) === JSON.stringify(["ROOM1_2"]),
        `סבב ${round}: ${keys} (ok=${ok})`
      );
    }
  });

  test("לחיצה כפולה/רענון: אותה החזקה מוחזרת ואין כפילות; תקרת החזקות למשתמש", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => hold(userA, "ROOM3", 9)));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(await prisma.appointment.count({}), 1);

    await hold(userA, "ROOM3", 10);
    await hold(userA, "ROOM3", 11);
    await assert.rejects(() => hold(userA, "ROOM3", 12), /מספר החזקות/);
    // מנהל פטור מהתקרה
    for (const h of [9, 10, 11, 12]) await svc.holdRoom({ userId: adminId, roomKey: "ROOM4", ...slot(h), source: "ADMIN" });
  });

  // ───────────── תשלום ואישור ─────────────

  test("תשלום מוצלח מאשר את ההזמנה רק אחרי אימות מהספק, והחדר נשאר חסום", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    assert.equal(started.amountAgorot, 5200);

    // עד שהספק לא אישר, אין אישור (גם אם קוראים לאימות שוב ושוב)
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "PENDING");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    await provider.completeCheckout(started.providerPaymentId, "success");
    const res = await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    assert.equal(res.outcome, "CONFIRMED");

    const appt = await apptOf(h.id);
    assert.equal(appt.status, "CONFIRMED");
    assert.equal(appt.paymentStatus, "PAID");
    assert.equal(appt.holdExpiresAt, null);
    const pay = await payOf(started.paymentId);
    assert.equal(pay.status, "SUCCEEDED");
    assert.ok(pay.paidAt);
    assert.equal(pay.environment, "SANDBOX");

    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);
    // אימות חוזר אידמפוטנטי
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "ALREADY_CONFIRMED");
  });

  test("תשלום שנכשל: ההזמנה לא מאושרת, ההחזקה נשארת, וניסיון חוזר מתאפשר", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "failure");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "PAYMENT_FAILED");
    assert.equal((await payOf(started.paymentId)).status, "FAILED");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    const retry = await svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider });
    assert.notEqual(retry.paymentId, started.paymentId);
    assert.notEqual(retry.providerPaymentId, started.providerPaymentId);
    await provider.completeCheckout(retry.providerPaymentId, "success");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: retry.paymentId, provider })).outcome, "CONFIRMED");
  });

  test("תשלום שבוטל לא מאשר הזמנה", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.cancelPayment(started.providerPaymentId);
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "PAYMENT_CANCELLED");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("תשלום שהגיע אחרי פקיעת ההחזקה: לא מאשר הזמנה, מוחזר במלואו, והחדר פנוי", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");

    const afterExpiry = new Date(Date.now() + 11 * MIN);
    const res = await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, now: afterExpiry });
    assert.equal(res.outcome, "LATE_REFUNDED");

    assert.equal((await apptOf(h.id)).status, "CANCELLED");
    assert.equal((await apptOf(h.id)).paymentStatus, "REFUNDED");
    const refunds = await prisma.refund.findMany({ where: { paymentId: started.paymentId } });
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].status, "SUCCEEDED");
    assert.equal(refunds[0].amountAgorot, 5200);
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 5200);

    // הפעלה חוזרת לא מחזירה פעמיים
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, now: afterExpiry })).outcome, "LATE_REFUNDED");
    assert.equal(await prisma.refund.count({ where: { paymentId: started.paymentId } }), 1);
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 5200);

    // והחדר פנוי למשתמש אחר
    await hold(userB, "ROOM3", 10);
  });

  test("תשלום מאוחר שמגיע אחרי שהחדר נתפס ע\"י אחר: ההזמנה של האחר נשמרת והלקוח מקבל החזר", async () => {
    const { started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");
    const later = new Date(Date.now() + 11 * MIN);
    const other = await hold(userB, "ROOM3", 10, { now: later });
    await prisma.appointment.update({ where: { id: other.id }, data: { status: "CONFIRMED", holdExpiresAt: null } });

    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, now: later })).outcome, "LATE_REFUNDED");
    assert.equal((await apptOf(other.id)).status, "CONFIRMED");
    assert.equal(await prisma.appointment.count({ where: { status: "CONFIRMED" } }), 1);
  });

  // ───────────── Webhook, כפילויות והפעלה מחדש ─────────────

  test("webhook: כפילות מזוהה, והזמנה מאושרת פעם אחת (כולל משלוחים מקבילים)", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");
    const signed = provider.buildWebhook({ eventId: "evt_dup", type: "payment.updated", providerPaymentId: started.providerPaymentId });

    const results = await Promise.all(Array.from({ length: 5 }, () => svc.handlePaymentWebhook({ provider, ...signed })));
    assert.ok(results.some((r) => r.outcome === "PROCESSED"));
    assert.ok(results.every((r) => r.outcome === "PROCESSED" || r.outcome === "DUPLICATE"));
    assert.equal(await prisma.webhookEvent.count({ where: { eventId: "evt_dup" } }), 1);
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");
    assert.equal(await prisma.payment.count({ where: { status: "SUCCEEDED" } }), 1);

    assert.equal((await svc.handlePaymentWebhook({ provider, ...signed })).outcome, "DUPLICATE");
  });

  test("webhook: חתימה שגויה נדחית ולא משנה כלום; אירוע לתשלום לא מוכר נדחה לטיפול מאוחר", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");
    const signed = provider.buildWebhook({ eventId: "evt_x", type: "payment.updated", providerPaymentId: started.providerPaymentId });

    await assert.rejects(
      () => svc.handlePaymentWebhook({ provider, rawBody: signed.rawBody, headers: { "x-mock-signature": "00" } }),
      WebhookVerificationError
    );
    const forged = new MockPaymentProvider("attacker-secret-0123456789").buildWebhook({
      eventId: "evt_forged",
      type: "payment.updated",
      providerPaymentId: started.providerPaymentId,
    });
    await assert.rejects(() => svc.handlePaymentWebhook({ provider, ...forged }), WebhookVerificationError);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT", "אירוע לא מאומת לא מאשר הזמנה");
    assert.equal(await prisma.webhookEvent.count({}), 0);

    const unknown = provider.buildWebhook({ eventId: "evt_unknown", type: "payment.updated", providerPaymentId: "mock_pay_nope" });
    assert.equal((await svc.handlePaymentWebhook({ provider, ...unknown })).outcome, "DEFERRED");
    assert.equal((await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_unknown" } })).processedAt, null);
  });

  test("webhook אמיתי (חתום) על תשלום שעדיין ממתין אצל הספק לא מאשר הזמנה: הסטטוס נשלף מחדש", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    const signed = provider.buildWebhook({ eventId: "evt_early", type: "payment.updated", providerPaymentId: started.providerPaymentId });
    const res = await svc.handlePaymentWebhook({ provider, ...signed });
    assert.equal(res.finalize?.outcome, "PENDING");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("לחיצה כפולה על תשלום: תשלום ממתין אחד בלבד אצלנו ואצל הספק", async () => {
    const h = await hold(userA, "ROOM3", 10);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.startBookingPayment({ appointmentId: h.id, userId: userA, provider }))
    );
    assert.equal(new Set(results.map((r) => r.paymentId)).size, 1);
    assert.equal(new Set(results.map((r) => r.providerPaymentId)).size, 1);
    assert.equal(await prisma.payment.count({ where: { appointmentId: h.id } }), 1);
    assert.equal(await prisma.mockProviderRecord.count({ where: { key: { startsWith: "pay:" } } }), 1);
  });

  test("הפעלה מחדש באמצע תשלום: מצב התשלום והספק נשמרים ב-PostgreSQL, לא בזיכרון התהליך", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);

    // "השרת קם מחדש": מופע ספק חדש לגמרי ואחסון חדש, בלי שום מצב בזיכרון
    const afterRestart1 = newProvider();
    await afterRestart1.completeCheckout(started.providerPaymentId, "success");
    const afterRestart2 = newProvider();
    const res = await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider: afterRestart2 });
    assert.equal(res.outcome, "CONFIRMED");
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");

    // וגם בקשת התשלום החוזרת (אותו מפתח) אחרי הפעלה מחדש מחזירה את אותו תשלום אצל הספק
    const h2 = await hold(userB, "ROOM4", 10);
    const s1 = await svc.startBookingPayment({ appointmentId: h2.id, userId: userB, provider });
    const s2 = await svc.startBookingPayment({ appointmentId: h2.id, userId: userB, provider: newProvider() });
    assert.equal(s1.providerPaymentId, s2.providerPaymentId);
  });

  test("כישלון זמני בין אישור הספק לעדכון ההזמנה: שום דבר לא אבד, וניסיון חוזר/reconcile משלים", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");

    await assert.rejects(
      () => svc.finalizeBookingPayment({ paymentId: started.paymentId, provider, beforeApply: async () => { throw new Error("db blip"); } }),
      /db blip/
    );
    assert.equal((await payOf(started.paymentId)).status, "PENDING");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    const rec = await svc.reconcilePendingPayments({ provider, olderThanMs: 0 });
    assert.deepEqual(rec.errors, []);
    assert.equal(rec.results[0].outcome, "CONFIRMED");
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");
  });

  test("reconcile משחזר תשלום שקרס לפני שמירת מזהה הספק", async () => {
    const h = await hold(userA, "ROOM3", 10);
    const pay = await prisma.payment.create({
      data: {
        userId: userA, appointmentId: h.id, purpose: "BOOKING", amountAgorot: 5200, status: "PENDING",
        environment: "SANDBOX", provider: "mock", idempotencyKey: `booking:${h.id}:1`,
      },
    });
    const rec = await svc.reconcilePendingPayments({ provider, olderThanMs: 0 });
    assert.deepEqual(rec.errors, []);
    const fixed = await payOf(pay.id);
    assert.ok(fixed.providerPaymentId);
    await provider.completeCheckout(fixed.providerPaymentId!, "success");
    assert.equal((await svc.finalizeBookingPayment({ paymentId: pay.id, provider })).outcome, "CONFIRMED");
  });

  // ───────────── הרשאות ועקיפות ─────────────

  test("משתמש אחר לא יכול לשלם, לאשר או לבטל הזמנה שאינה שלו; לא-מנהל לא מאשר החזר", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await assert.rejects(() => svc.startBookingPayment({ appointmentId: h.id, userId: userB, provider }), { code: "NOT_FOUND" });
    await assert.rejects(
      () => svc.cancelBooking({ appointmentId: h.id, requester: { id: userB, role: "CLIENT" }, provider }),
      { code: "NOT_FOUND" }
    );
    await assert.rejects(() => svc.approveCancellationRefund({ appointmentId: h.id, adminId: userB, provider }), { code: "FORBIDDEN" });
    await assert.rejects(() => svc.createAdminBookingWithDebt({ adminId: userB, userId: userB, roomKey: "ROOM4", ...slot(10) }), { code: "FORBIDDEN" });
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
    assert.equal((await payOf(started.paymentId)).status, "PENDING");
  });

  test("אי אפשר לעקוף את התשלום: סכום שונה, סביבה שונה, ותשלום כפול מוצלח נחסמים", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");

    // הסכום ששמרנו אצלנו שונה ממה שהספק גבה: לא מאשרים
    await prisma.payment.update({ where: { id: started.paymentId }, data: { amountAgorot: 100 } });
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "AMOUNT_MISMATCH");
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
    await prisma.payment.update({ where: { id: started.paymentId }, data: { amountAgorot: 5200 } });

    // תשלום sandbox לא נפתר מול ספק שאינו sandbox
    await prisma.payment.update({ where: { id: started.paymentId }, data: { environment: "LIVE" } });
    await assert.rejects(() => svc.finalizeBookingPayment({ paymentId: started.paymentId, provider }), { code: "INVALID" });
    await prisma.payment.update({ where: { id: started.paymentId }, data: { environment: "SANDBOX" } });

    // תשלום של הזמנה אחרת (אותו סכום) לא מאשר הזמנה זו
    const other = await holdAndStart(userB, "ROOM4", 10);
    await prisma.payment.update({ where: { id: started.paymentId }, data: { providerPaymentId: other.started.providerPaymentId } }).catch(() => undefined);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT", "ללא תשלום מוצלח אצל הספק אין אישור");
    await prisma.payment.update({ where: { id: started.paymentId }, data: { providerPaymentId: started.providerPaymentId } });

    // האילוצים במסד: לא ניתן ליצור תשלום הזמנה שני ממתין/מוצלח לאותה הזמנה
    await assert.rejects(
      () => prisma.payment.create({
        data: { userId: userA, appointmentId: h.id, purpose: "BOOKING", amountAgorot: 5200, status: "PENDING", environment: "SANDBOX", provider: "mock", idempotencyKey: "dup-pending" },
      }),
      /Unique|unique/
    );
    assert.equal((await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider })).outcome, "CONFIRMED");
    await assert.rejects(
      () => prisma.payment.create({
        data: { userId: userA, appointmentId: h.id, purpose: "BOOKING", amountAgorot: 5200, status: "SUCCEEDED", environment: "SANDBOX", provider: "mock", idempotencyKey: "dup-success" },
      }),
      /Unique|unique/
    );
  });

  test("הזמנה בתשלום לא מבוטלת במסלול הישן (שיאבד תשלום), רק דרך ביטול עם החזר", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    await assert.rejects(() => booking.cancelAppointment(h.id, { id: userA, role: "CLIENT" }), /החזר/);
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");
  });

  // ───────────── הזמנת מנהל ─────────────

  test("הזמנת מנהל ללא תשלום: מאושרת מיד, חוב פתוח רשום, הלקוח לא נחסם, וההתנגשויות נאכפות", async () => {
    const res = await svc.createAdminBookingWithDebt({
      adminId, userId: userA, roomKey: "ROOM3", ...slot(10), reason: "הסכמה טלפונית",
    });
    assert.equal(res.appointment.status, "CONFIRMED");
    assert.equal(res.appointment.paymentStatus, "DEBT");
    assert.equal(res.appointment.source, "ADMIN");
    assert.equal(res.debt?.amountAgorot, 5200);
    assert.equal(res.debt?.status, "OPEN");
    assert.equal(res.debt?.createdById, adminId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userA } })).status, "APPROVED");

    await assert.rejects(() => svc.createAdminBookingWithDebt({ adminId, userId: userB, roomKey: "ROOM3", ...slot(10) }), booking.BookingError);
    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);
    assert.equal(await prisma.debt.count({}), 1);
    // חוב פתוח לא חוסם הזמנות נוספות של הלקוח
    await hold(userA, "ROOM4", 10);
  });

  test("מקביליות: מנהל מול לקוח על אותו חדר, בדיוק אחד מצליח", async () => {
    for (let round = 0; round < 8; round++) {
      await wipe();
      const results = await Promise.allSettled([
        svc.createAdminBookingWithDebt({ adminId, userId: userA, roomKey: "ROOM3", ...slot(10) }),
        svc.holdRoom({ userId: userB, roomKey: "ROOM3", ...slot(10), source: "WEB" }),
        svc.createAdminBookingWithDebt({ adminId, userId: userB, roomKey: "ROOM3", ...slot(10) }),
      ]);
      assert.equal(results.filter((r) => r.status === "rejected" && !(r.reason instanceof booking.BookingError)).length, 0);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `סבב ${round}`);
      const blocking = await prisma.appointment.count({ where: booking.blockingAppointmentWhere(new Date()) });
      assert.equal(blocking, 1);
    }
  });

  // ───────────── ביטולים והחזרים ─────────────

  async function paidBooking(hour: number) {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", hour);
    await provider.completeCheckout(started.providerPaymentId, "success");
    await svc.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    return { h, started };
  }

  test("ביטול 24 שעות ומעלה לפני ההתחלה מזכה בהחזר מלא (כולל בדיוק 24 שעות)", async () => {
    const { h, started } = await paidBooking(10);
    const exactly24h = new Date(h.startTime.getTime() - 24 * 3600_000);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: exactly24h });
    assert.equal(res.outcome, "REFUNDED");
    const appt = await apptOf(h.id);
    assert.equal(appt.status, "CANCELLED");
    assert.equal(appt.paymentStatus, "REFUNDED");
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 5200);
    assert.equal((await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider })).outcome, "ALREADY_CANCELLED");
    assert.equal(await prisma.refund.count({ where: { paymentId: started.paymentId } }), 1);
  });

  test("ביטול בפחות מ-24 שעות: בלי החזר אוטומטי; אישור מנהל מחזיר פעם אחת בלבד", async () => {
    const { h, started } = await paidBooking(10);
    const within = new Date(h.startTime.getTime() - 23 * 3600_000);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider, now: within });
    assert.equal(res.outcome, "CANCELLED_NO_REFUND");
    assert.equal(await prisma.refund.count({ where: { paymentId: started.paymentId } }), 0);
    assert.equal((await apptOf(h.id)).paymentStatus, "PAID");

    const approved = await svc.approveCancellationRefund({ appointmentId: h.id, adminId, provider });
    assert.equal(approved.refund?.status, "SUCCEEDED");
    await svc.approveCancellationRefund({ appointmentId: h.id, adminId, provider });
    assert.equal(await prisma.refund.count({ where: { paymentId: started.paymentId } }), 1);
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).refundedAgorot, 5200);
    assert.equal((await apptOf(h.id)).paymentStatus, "REFUNDED");
  });

  test("מנהל מבטל ללא הגבלה ואישור מנהל לא קורה אוטומטית; הזמנה שלא שולמה מבוטלת בלי החזר", async () => {
    const res = await svc.createAdminBookingWithDebt({ adminId, userId: userA, roomKey: "ROOM3", ...slot(10) });
    const out = await svc.cancelBooking({ appointmentId: res.appointment.id, requester: { id: adminId, role: "ADMIN" }, provider });
    assert.equal(out.outcome, "CANCELLED_NO_PAYMENT");
  });

  test("ביטול החזקה מבטל את התשלום הממתין אצל הספק; תשלום אחריו לא אפשרי", async () => {
    const { hold: h, started } = await holdAndStart(userA, "ROOM3", 10);
    const res = await svc.cancelBooking({ appointmentId: h.id, requester: { id: userA, role: "CLIENT" }, provider });
    assert.equal(res.outcome, "HOLD_CANCELLED");
    assert.equal((await payOf(started.paymentId)).status, "CANCELLED");
    assert.equal((await provider.getPaymentStatus(started.providerPaymentId)).status, "CANCELLED");
    await assert.rejects(() => provider.completeCheckout(started.providerPaymentId, "success"));
    await hold(userB, "ROOM3", 10);
  });

  test("expireStaleHolds: מבטל החזקות שפגו ותשלומים ממתינים; תשלום שכבר הצליח מוחזר", async () => {
    const a = await holdAndStart(userA, "ROOM3", 10);
    const b = await holdAndStart(userB, "ROOM4", 10);
    await provider.completeCheckout(b.started.providerPaymentId, "success"); // הצליח אך לא אומת עדיין
    const live = await hold(userA, "ROOM3", 11); // לא פגה
    await prisma.appointment.updateMany({
      where: { id: { in: [a.hold.id, b.hold.id] } },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await svc.expireStaleHolds({ provider });
    assert.equal(res.expired, 2);
    assert.equal((await apptOf(a.hold.id)).status, "CANCELLED");
    assert.equal((await payOf(a.started.paymentId)).status, "CANCELLED");
    assert.equal((await apptOf(live.id)).status, "PENDING_PAYMENT");

    assert.equal((await payOf(b.started.paymentId)).status, "SUCCEEDED");
    assert.equal((await apptOf(b.hold.id)).status, "CANCELLED");
    assert.equal((await provider.getPaymentStatus(b.started.providerPaymentId)).refundedAgorot, 5200);

    assert.equal((await svc.expireStaleHolds({ provider })).expired, 0);
  });

  // ───────────── רגרסיה: המסלול הקיים ─────────────

  test("רגרסיה: createAppointment ממשיך לאשר מיד, בלי החזקה ובלי תשלום", async () => {
    const appt = await booking.createAppointment({ userId: userA, roomKey: "ROOM3", ...slot(10), source: "WEB" });
    assert.equal(appt.status, "CONFIRMED");
    assert.equal(appt.paymentStatus, "NOT_REQUIRED");
    assert.equal(appt.holdExpiresAt, null);
    assert.equal(await prisma.payment.count({}), 0);
    await assert.rejects(() => hold(userB, "ROOM3", 10), booking.BookingError);
    const cancelled = await booking.cancelAppointment(appt.id, { id: userA, role: "CLIENT" });
    assert.equal(cancelled.status, "CANCELLED");
    await hold(userB, "ROOM3", 10);
  });
});
