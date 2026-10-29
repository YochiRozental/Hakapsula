import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient, RoomKey } from "@/generated/prisma/client";

// בדיקות כרטיס שמור (Mock), הרשאה חד-פעמית וביצוע פעולות מורשות מול PostgreSQL מקומי ייעודי. רצות רק כש-
// SAVEDCARD_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test. דוגמה:
//   SAVEDCARD_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_savedcard_test npm test
const testUrl = process.env.SAVEDCARD_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) throw new Error("SAVEDCARD_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
}

const SECRET = "saved-card-test-secret-0123456789";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const PIN = "4821";
const DAY = 24 * 3600_000;
const MIN = 60_000;

describe("כרטיס שמור, הרשאה חד-פעמית וביצוע מורשה", { skip: !testUrl && "SAVEDCARD_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let booking: typeof import("@/lib/booking");
  let svc: typeof import("@/lib/payments/booking-payment");
  let methods: typeof import("@/lib/payments/saved-methods");
  let authz: typeof import("@/lib/payments/authorization");
  let actions: typeof import("@/lib/payments/authorized-actions");
  let pw: typeof import("@/lib/password");
  let MockPaymentProvider: typeof import("@/lib/payments/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let provider: InstanceType<typeof MockPaymentProvider>;
  let mondayMs: number;
  const ids: Record<string, string> = {};

  const slot = (hour: number, minutes = 60) => {
    const startTime = new Date(mondayMs + hour * 3600_000);
    return { startTime, endTime: new Date(startTime.getTime() + minutes * MIN) };
  };
  const newProvider = () => new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));

  async function wipe() {
    await prisma.paymentAuthorization.deleteMany({});
    await prisma.creditUsage.deleteMany({});
    await prisma.packageUsage.deleteMany({});
    await prisma.credit.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.hoursPackage.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.ivrPinEvent.deleteMany({});
    await prisma.appointment.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = await import("@/lib/prisma"));
    booking = await import("@/lib/booking");
    svc = await import("@/lib/payments/booking-payment");
    methods = await import("@/lib/payments/saved-methods");
    authz = await import("@/lib/payments/authorization");
    actions = await import("@/lib/payments/authorized-actions");
    pw = await import("@/lib/password");
    ({ MockPaymentProvider } = await import("@/lib/payments/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    const { jerusalemParts } = await import("@/lib/opening-hours");

    const d = new Date();
    d.setDate(d.getDate() + 90);
    while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    mondayMs = d.getTime();

    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sc " } } });
  });

  beforeEach(async () => {
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sc " } } });
    provider = newProvider();
    const passwordHash = await pw.hashPassword(SITE_PASSWORD);
    const ivrPinHash = await pw.hashPassword(PIN);
    const mk = async (key: string, extra: Record<string, unknown> = {}) => {
      ids[key] = (
        await prisma.user.create({
          data: { name: `sc ${key}`, email: `sc-${key}@test.local`, passwordHash, gender: "MALE", status: "APPROVED", ivrPinHash, ...(extra as object) } as never,
        })
      ).id;
    };
    await mk("a");
    await mk("b");
    await mk("noPin", { ivrPinHash: null });
    await mk("admin", { role: "ADMIN" });
    await mk("temp", { mustChangePassword: true });
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sc " } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────
  const hold = (userId: string, room: RoomKey, hour: number, minutes = 60) =>
    booking.createBookingHold({ userId, roomKey: room, ...slot(hour, minutes), source: "IVR" });
  const addCard = async (userId: string) => {
    const res = await methods.addMockCard({ userId, currentPassword: SITE_PASSWORD, provider });
    assert.equal(res.status, "OK");
    return res.status === "OK" ? res.method : (undefined as never);
  };
  const seedPackage = (userId: string, minutes: number, expiresAt = new Date(Date.now() + 300 * DAY)) =>
    prisma.hoursPackage.create({ data: { userId, hours: 5, pricePaidAgorot: 19500, minutesTotal: minutes, minutesRemaining: minutes, expiresAt } });
  const remaining = async (userId: string) =>
    (await prisma.hoursPackage.aggregate({ where: { userId }, _sum: { minutesRemaining: true } }))._sum.minutesRemaining ?? 0;
  const apptOf = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });
  const providerPayments = () => prisma.mockProviderRecord.count({ where: { key: { startsWith: "pay:" } } });

  async function authorize(userId: string, appointmentId: string, action: "CONFIRM_BALANCE" | "PAY_CARD", amountAgorot: number, packageMinutes: number, pin = PIN) {
    const res = await authz.authorizeWithPin({ userId, pin, appointmentId, action, amountAgorot, packageMinutes });
    assert.equal(res.status, "OK", JSON.stringify(res));
    return res.status === "OK" ? res.authorizationId : "";
  }
  const run = (authorizationId: string, userId: string, appointmentId: string, extra: Record<string, unknown> = {}) =>
    actions.executeAuthorizedBooking({ authorizationId, userId, appointmentId, provider, ...(extra as object) });

  // ───────────── כרטיס מדומה ─────────────

  test("שמירת כרטיס מדומה: דורש סיסמת אתר, מחזיר תצוגה מוסתרת בלבד, ושורת SANDBOX עם טוקן mock", async () => {
    assert.equal((await methods.addMockCard({ userId: ids.a, currentPassword: "wrong", provider })).status, "INVALID_PASSWORD");
    assert.equal((await methods.addMockCard({ userId: ids.a, currentPassword: "", provider })).status, "INVALID_PASSWORD");
    assert.equal(await prisma.paymentMethod.count({}), 0);

    const view = await addCard(ids.a);
    assert.deepEqual(Object.keys(view).sort(), ["brand", "createdAt", "expiry", "id", "last4", "sandbox"]);
    assert.equal(view.sandbox, true);
    const row = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: view.id } });
    assert.deepEqual([row.userId, row.provider, row.environment, row.active], [ids.a, "mock", "SANDBOX", true]);
    assert.match(row.token, /^mock_tok_/);
    assert.ok(!JSON.stringify(view).includes(row.token), "הטוקן לא בתצוגה");
    assert.deepEqual((await methods.listPaymentMethods(ids.a)).map((m) => m.id), [view.id]);
    assert.deepEqual(await methods.listPaymentMethods(ids.b), [], "אמצעי תשלום של אחר אינם נראים");
  });

  test("שמירת כרטיס: הגבלת ניסיונות סיסמה, מגבלת 3 כרטיסים, חשבון אסור וספק שאינו Mock", async () => {
    for (let i = 0; i < 4; i++) await methods.addMockCard({ userId: ids.b, currentPassword: `bad${i}`, provider });
    assert.equal((await methods.addMockCard({ userId: ids.b, currentPassword: `bad5`, provider })).status, "BLOCKED");
    assert.equal((await methods.addMockCard({ userId: ids.b, currentPassword: SITE_PASSWORD, provider })).status, "BLOCKED", "סיסמה נכונה לא עוקפת חסימה");
    assert.equal(await prisma.paymentMethod.count({ where: { userId: ids.b } }), 0);

    await addCard(ids.a);
    await addCard(ids.a);
    await addCard(ids.a);
    assert.equal((await methods.addMockCard({ userId: ids.a, currentPassword: SITE_PASSWORD, provider })).status, "LIMIT");
    assert.equal((await methods.addMockCard({ userId: ids.admin, currentPassword: SITE_PASSWORD, provider })).status, "NOT_ALLOWED");
    assert.equal((await methods.addMockCard({ userId: ids.temp, currentPassword: SITE_PASSWORD, provider })).status, "NOT_ALLOWED");
    const fake = { name: "payme", environment: "live" } as never;
    assert.equal((await methods.addMockCard({ userId: ids.a, currentPassword: SITE_PASSWORD, provider: fake })).status, "NOT_SANDBOX");
  });

  test("שמיש רק כשהספק מאשר: שורה פעילה, אותה סביבה וספק, טוקן שהונפק, ושל אותו משתמש", async () => {
    const view = await addCard(ids.a);
    const usable = await methods.findUsableCard(ids.a, provider);
    assert.equal(usable?.id, view.id);
    assert.equal(await methods.findUsableCard(ids.b, provider), null, "לא של משתמש אחר");

    // טוקן שנדחה אצל הספק
    await provider.declineToken(usable!.token);
    assert.equal(await methods.findUsableCard(ids.a, provider), null);
    await prisma.paymentMethod.deleteMany({});

    // רישום במסד בלבד, בלי טוקן אצל הספק (או טוקן שאינו שלנו): אינו שמיש
    await prisma.paymentMethod.create({ data: { userId: ids.a, provider: "mock", environment: "SANDBOX", token: "mock_tok_never-issued", last4: "1111" } });
    await prisma.paymentMethod.create({ data: { userId: ids.a, provider: "mock", environment: "SANDBOX", token: "tok_real_looking_123", last4: "2222" } });
    assert.equal(await methods.findUsableCard(ids.a, provider), null);

    // שורת LIVE לא נטענת מול ספק sandbox
    const issued = await provider.issueSandboxToken();
    await prisma.paymentMethod.create({ data: { userId: ids.a, provider: "mock", environment: "LIVE", token: issued.token, last4: "4242" } });
    assert.equal(await methods.findUsableCard(ids.a, provider), null, "SANDBOX לעולם לא נחשב LIVE ולהפך");

    // ספק שאינו יודע לאמת טוקן: אין כרטיס שמיש
    const noCheck = { name: "mock", environment: "sandbox" } as never;
    assert.equal(await methods.findUsableCard(ids.a, noCheck), null);
  });

  test("הסרת אמצעי תשלום: רק של המשתמש עצמו, ולאחר ההסרה אינו שמיש", async () => {
    const view = await addCard(ids.a);
    await assert.rejects(() => methods.removePaymentMethod({ userId: ids.b, methodId: view.id, provider }), { code: "NOT_FOUND" });
    assert.equal(await prisma.paymentMethod.count({ where: { active: true } }), 1);
    await methods.removePaymentMethod({ userId: ids.a, methodId: view.id, provider });
    assert.equal(await methods.findUsableCard(ids.a, provider), null);
    await assert.rejects(() => methods.removePaymentMethod({ userId: ids.a, methodId: view.id, provider }), { code: "NOT_FOUND" });
  });

  // ───────────── הרשאה חד-פעמית ─────────────

  test("הרשאה: מונפקת רק אחרי קוד נכון וקשורה לפעולה; קוד שגוי/לא מוגדר/החזקה לא פעילה לא מנפיקים", async () => {
    const h = await hold(ids.a, "ROOM3", 10);
    const bad = await authz.authorizeWithPin({ userId: ids.a, pin: "0000", appointmentId: h.id, action: "PAY_CARD", amountAgorot: 5200, packageMinutes: 0 });
    assert.deepEqual(bad, { status: "INVALID", attemptsLeft: 4 });
    assert.equal(await prisma.paymentAuthorization.count({}), 0);

    const hn = await hold(ids.noPin, "ROOM4", 10);
    assert.deepEqual(await authz.authorizeWithPin({ userId: ids.noPin, pin: PIN, appointmentId: hn.id, action: "PAY_CARD", amountAgorot: 5200, packageMinutes: 0 }), { status: "NOT_SET" });

    // הזמנה של אחר / החזקה שפגה: לא נבדק קוד
    assert.deepEqual(await authz.authorizeWithPin({ userId: ids.b, pin: PIN, appointmentId: h.id, action: "PAY_CARD", amountAgorot: 5200, packageMinutes: 0 }), { status: "HOLD_INACTIVE" });
    const expired = await authz.authorizeWithPin({ userId: ids.a, pin: PIN, appointmentId: h.id, action: "PAY_CARD", amountAgorot: 5200, packageMinutes: 0, now: new Date(Date.now() + 11 * MIN) });
    assert.deepEqual(expired, { status: "HOLD_INACTIVE" });
    assert.equal((await prisma.pinThrottle.findUnique({ where: { scope_subject: { scope: "VERIFY", subject: ids.b } } })), null, "לא נרשם ניסיון");

    await assert.rejects(() => authz.authorizeWithPin({ userId: ids.a, pin: PIN, appointmentId: h.id, action: "CONFIRM_BALANCE", amountAgorot: 100, packageMinutes: 60 }), RangeError);
    const ok = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);
    const row = await prisma.paymentAuthorization.findUniqueOrThrow({ where: { id: ok } });
    assert.deepEqual([row.userId, row.appointmentId, row.action, row.amountAgorot, row.packageMinutes, row.consumedAt], [ids.a, h.id, "PAY_CARD", 5200, 0, null]);
    assert.ok(row.expiresAt.getTime() - row.createdAt.getTime() <= 61_000, "תוקף קצר");
    assert.equal(ok.length, 32);
  });

  test("הרשאה חד-פעמית: נצרכת פעם אחת, רק למשתמש ולהזמנה שלה, לפני פקיעה; הרשאה חדשה מבטלת קודמת", async () => {
    const h = await hold(ids.a, "ROOM3", 10);
    const h2 = await hold(ids.a, "ROOM4", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);

    assert.equal(await authz.consumeAuthorization({ id, userId: ids.b, appointmentId: h.id }), null, "משתמש אחר");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h2.id }), null, "הזמנה אחרת");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id, now: new Date(Date.now() + 61_000) }), null, "פגה");
    assert.equal((await prisma.paymentAuthorization.findUniqueOrThrow({ where: { id } })).consumedAt, null, "ניסיונות כושלים לא שרפו אותה");

    const results = await Promise.all(Array.from({ length: 10 }, () => authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id })));
    assert.equal(results.filter(Boolean).length, 1, "בקשות מקבילות: צריכה אחת בלבד");
    assert.equal(await authz.consumeAuthorization({ id, userId: ids.a, appointmentId: h.id }), null, "שימוש חוזר");

    const first = await authorize(ids.a, h2.id, "PAY_CARD", 5200, 0);
    const second = await authorize(ids.a, h2.id, "PAY_CARD", 5200, 0);
    assert.equal(await authz.consumeAuthorization({ id: first, userId: ids.a, appointmentId: h2.id }), null, "הרשאה קודמת בוטלה");
    assert.ok(await authz.consumeAuthorization({ id: second, userId: ids.a, appointmentId: h2.id }));
  });

  // ───────────── ביצוע: יתרה ─────────────

  test("תשלום מיתרה: מאשר, מנכה פעם אחת, ובקשה חוזרת עם אותה הרשאה לא עושה דבר", async () => {
    await seedPackage(ids.a, 300);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "CONFIRM_BALANCE", 0, 60);

    const res = await run(id, ids.a, h.id);
    assert.deepEqual(res, { status: "CONFIRMED", via: "BALANCE", paidFromBalanceMinutes: 60, paidCashAgorot: 0 });
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.status, appt.paymentStatus, appt.paidFromBalanceMinutes, appt.paidCashAgorot], ["CONFIRMED", "PAID", 60, 0]);
    assert.equal(await remaining(ids.a), 240);
    assert.equal(await prisma.payment.count({}), 0, "אין תשלום בכסף");

    assert.deepEqual(await run(id, ids.a, h.id), { status: "AUTH_INVALID" });
    assert.equal(await remaining(ids.a), 240, "בקשה חוזרת לא ניכתה שוב");
  });

  test("תשלום מיתרה: היתרה השתנתה אחרי ההרשאה -> נדחה בלי ניכוי חלקי; החזקה שפגה -> בלי ניכוי", async () => {
    await seedPackage(ids.a, 60);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "CONFIRM_BALANCE", 0, 60);
    await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 15 } });
    assert.deepEqual(await run(id, ids.a, h.id), { status: "INSUFFICIENT_BALANCE" });
    assert.equal(await remaining(ids.a), 15);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");

    await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 60 } });
    // ההרשאה בתוקף, אבל ההחזקה פגה (לפי המסד) לפני הביצוע: אין ניכוי
    const id2 = await authorize(ids.a, h.id, "CONFIRM_BALANCE", 0, 60);
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(await run(id2, ids.a, h.id), { status: "HOLD_EXPIRED" });
    assert.equal(await remaining(ids.a), 60);

    // והרשאה שפגה (60 שניות) נדחית בלי קשר להחזקה
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() + 5 * MIN) } });
    const id3 = await authorize(ids.a, h.id, "CONFIRM_BALANCE", 0, 60);
    assert.deepEqual(await run(id3, ids.a, h.id, { now: new Date(Date.now() + 2 * MIN) }), { status: "AUTH_INVALID" });
    assert.equal(await remaining(ids.a), 60);
  });

  // ───────────── ביצוע: כרטיס שמור ─────────────

  test("חיוב כרטיס שמור מלא: Payment יחיד עם האמצעי, הזמנה מאושרת, וחיוב אחד אצל הספק", async () => {
    const card = await addCard(ids.a);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);

    const res = await run(id, ids.a, h.id);
    assert.deepEqual(res, { status: "CONFIRMED", via: "CARD", paidFromBalanceMinutes: 0, paidCashAgorot: 5200 });
    const payments = await prisma.payment.findMany({});
    assert.equal(payments.length, 1);
    assert.deepEqual([payments[0].status, payments[0].amountAgorot, payments[0].paymentMethodId, payments[0].environment, payments[0].purpose], ["SUCCEEDED", 5200, card.id, "SANDBOX", "BOOKING"]);
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.status, appt.paymentStatus, appt.paidCashAgorot, appt.paidFromBalanceMinutes], ["CONFIRMED", "PAID", 5200, 0]);
    assert.equal(await providerPayments(), 1);
    assert.deepEqual(await run(id, ids.a, h.id), { status: "AUTH_INVALID" });
    assert.equal(await providerPayments(), 1, "בקשה חוזרת לא חייבה שוב");
  });

  test("תשלום משולב: 30 דקות מהיתרה + 26 ₪ בכרטיס, הניכוי רק אחרי חיוב מוצלח", async () => {
    await addCard(ids.a);
    await seedPackage(ids.a, 30);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    const res = await run(id, ids.a, h.id);
    assert.deepEqual(res, { status: "CONFIRMED", via: "CARD", paidFromBalanceMinutes: 30, paidCashAgorot: 2600 });
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.paidFromBalanceMinutes, appt.paidCashAgorot], [30, 2600]);
    assert.equal(await remaining(ids.a), 0);
    assert.equal((await prisma.payment.findFirstOrThrow({})).packageMinutes, 30);
  });

  test("כישלון חיוב (כרטיס נדחה): לא מאושרת הזמנה, לא מנוכות דקות, Payment נכשל; ניסיון חדש דורש הרשאה חדשה", async () => {
    const card = await addCard(ids.a);
    await seedPackage(ids.a, 30);
    const row = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: card.id } });
    await provider.declineToken(row.token);
    // כרטיס שנדחה אינו שמיש בכלל: ההצעה לא מוצגת
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    assert.deepEqual(await run(id, ids.a, h.id), { status: "NO_PAYMENT_METHOD" });
    assert.equal(await remaining(ids.a), 30);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
    assert.equal(await prisma.payment.count({}), 0, "לא נפתח תשלום");

    // הספק דוחה את החיוב עצמו (הכרטיס עדיין נראה שמיש)
    const issued = await provider.issueSandboxToken();
    await prisma.paymentMethod.updateMany({ where: { id: card.id }, data: { token: issued.token } });
    const orig = MockPaymentProvider.prototype.chargeSavedMethod;
    MockPaymentProvider.prototype.chargeSavedMethod = async function (this: unknown, input) {
      return { providerPaymentId: "mock_pay_declined_" + input.idempotencyKey, status: "FAILED", failureCode: "card_declined" };
    };
    try {
      const id2 = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
      // הצ'ארג' המדומה מחזיר FAILED אבל אין רשומת תשלום אצל הספק: finalize ייכשל באימות מול הספק
      await assert.rejects(() => run(id2, ids.a, h.id));
    } finally {
      MockPaymentProvider.prototype.chargeSavedMethod = orig;
    }
    assert.equal(await remaining(ids.a), 30);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
  });

  test("הספק מחזיר FAILED אמיתי: PAYMENT_FAILED, ההזמנה לא מאושרת ולא מנוכות דקות", async () => {
    await addCard(ids.a);
    await seedPackage(ids.a, 30);
    const h = await hold(ids.a, "ROOM3", 10);
    const orig = MockPaymentProvider.prototype.chargeSavedMethod;
    MockPaymentProvider.prototype.chargeSavedMethod = async function (this: InstanceType<typeof MockPaymentProvider>, input) {
      // מדמה ספק שמחזיר כישלון: יוצר תשלום נכשל אצל הספק דרך טוקן שנדחה
      const t = await this.issueSandboxToken();
      await this.declineToken(t.token);
      return orig.call(this, { ...input, token: t.token });
    };
    try {
      const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
      assert.deepEqual(await run(id, ids.a, h.id), { status: "PAYMENT_FAILED" });
    } finally {
      MockPaymentProvider.prototype.chargeSavedMethod = orig;
    }
    const payment = await prisma.payment.findFirstOrThrow({});
    assert.deepEqual([payment.status, payment.failureCode], ["FAILED", "card_declined"]);
    assert.equal(await remaining(ids.a), 30);
    const appt = await apptOf(h.id);
    assert.deepEqual([appt.status, appt.paidCashAgorot], ["PENDING_PAYMENT", 0]);
  });

  test("שגיאת ספק לא ברורה בחיוב: PROVIDER_ERROR, התשלום נסגר ככושל, ללא אישור וללא ניכוי וללא ניסיון אוטומטי נוסף", async () => {
    await addCard(ids.a);
    const h = await hold(ids.a, "ROOM3", 10);
    const orig = MockPaymentProvider.prototype.chargeSavedMethod;
    let calls = 0;
    MockPaymentProvider.prototype.chargeSavedMethod = async () => {
      calls++;
      throw new Error("network down");
    };
    try {
      const id = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);
      assert.deepEqual(await run(id, ids.a, h.id), { status: "PROVIDER_ERROR" });
    } finally {
      MockPaymentProvider.prototype.chargeSavedMethod = orig;
    }
    assert.equal(calls, 1);
    const payment = await prisma.payment.findFirstOrThrow({});
    assert.deepEqual([payment.status, payment.failureCode], ["FAILED", "provider_error"]);
    assert.equal((await apptOf(h.id)).status, "PENDING_PAYMENT");
    // ההתאמה התקופתית אינה מחייבת מחדש ואינה פותחת עמוד תשלום
    const rec = await svc.reconcilePendingPayments({ provider, olderThanMs: 0 });
    assert.deepEqual(rec.errors, []);
    assert.equal(calls, 1);
    // ניסיון חדש (הרשאה חדשה) יוצר תשלום חדש וחיוב חדש
    const id2 = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);
    assert.equal((await run(id2, ids.a, h.id)).status, "CONFIRMED");
    assert.equal(await prisma.payment.count({ where: { status: "SUCCEEDED" } }), 1);
  });

  test("אין כרטיס שמור או שהחלוקה השתנתה: לא מחייבים", async () => {
    await seedPackage(ids.a, 30);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    assert.deepEqual(await run(id, ids.a, h.id), { status: "NO_PAYMENT_METHOD" });

    await addCard(ids.a);
    const id2 = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 0 } }); // היתרה אזלה אחרי ההצגה
    assert.deepEqual(await run(id2, ids.a, h.id), { status: "PLAN_CHANGED" });
    assert.equal(await prisma.payment.count({}), 0);
    assert.equal(await providerPayments(), 0, "לא בוצע חיוב אצל הספק");
  });

  test("החזקה שפגה: אין חיוב; ותשלום שהתקבל אחרי הפקיעה מוחזר במלואו בלי אישור וניכוי", async () => {
    await addCard(ids.a);
    await seedPackage(ids.a, 30);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(await run(id, ids.a, h.id), { status: "HOLD_EXPIRED" });
    assert.equal(await providerPayments(), 0, "החזקה שפגה: אין חיוב");

    // החיוב הצליח, ובין החיוב לאישור ההחזקה פגה
    await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() + 5 * MIN) } });
    const id2 = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    const res = await run(id2, ids.a, h.id, {
      hooks: { beforeApply: async () => void (await prisma.appointment.update({ where: { id: h.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } })) },
    });
    assert.deepEqual(res, { status: "REFUNDED", reason: "LATE" });
    assert.equal((await apptOf(h.id)).status, "CANCELLED");
    assert.equal(await remaining(ids.a), 30, "לא נוכו דקות");
    const refund = await prisma.refund.findFirstOrThrow({});
    assert.deepEqual([refund.status, refund.amountAgorot], ["SUCCEEDED", 2600]);
  });

  test("שינוי יתרה אחרי החיוב: הכסף מוחזר במלואו, בלי ניכוי, וההזמנה מבוטלת", async () => {
    await addCard(ids.a);
    await seedPackage(ids.a, 30);
    const h = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h.id, "PAY_CARD", 2600, 30);
    const res = await run(id, ids.a, h.id, {
      hooks: { beforeApply: async () => void (await prisma.hoursPackage.updateMany({ where: { userId: ids.a }, data: { minutesRemaining: 0 } })) },
    });
    assert.deepEqual(res, { status: "REFUNDED", reason: "BALANCE_CHANGED" });
    assert.equal(await remaining(ids.a), 0, "אין יתרה שלילית");
    assert.equal((await apptOf(h.id)).status, "CANCELLED");
    assert.equal((await prisma.refund.findFirstOrThrow({})).amountAgorot, 2600);
  });

  test("חיוב כפול: ביצוע מקביל ישיר באותה הזמנה יוצר תשלום וחיוב אחד בלבד; והרשאה אחת מבצעת פעולה אחת", async () => {
    await addCard(ids.a);
    const h = await hold(ids.a, "ROOM3", 10);
    const direct = await Promise.allSettled(
      Array.from({ length: 6 }, () => svc.payBookingWithSavedCard({ appointmentId: h.id, userId: ids.a, provider, expected: { cashAgorot: 5200, packageMinutes: 0 } }))
    );
    assert.ok(direct.every((r) => r.status === "fulfilled" || r.reason instanceof Error), "ללא קריסות לא צפויות");
    assert.equal(await prisma.payment.count({ where: { appointmentId: h.id, status: "SUCCEEDED" } }), 1);
    assert.equal(await providerPayments(), 1, "חיוב אחד אצל הספק");
    assert.equal((await apptOf(h.id)).status, "CONFIRMED");

    await wipe();
    await addCard(ids.a);
    const h2 = await hold(ids.a, "ROOM3", 10);
    const id = await authorize(ids.a, h2.id, "PAY_CARD", 5200, 0);
    const results = await Promise.all(Array.from({ length: 6 }, () => run(id, ids.a, h2.id)));
    assert.equal(results.filter((r) => r.status === "CONFIRMED").length, 1);
    assert.equal(results.filter((r) => r.status === "AUTH_INVALID").length, 5);
    assert.equal(await providerPayments(), 1);
  });

  test("שתי הזמנות מקבילות על אותה יתרה, בהרשאות נפרדות: רק אחת מנוכה", async () => {
    await seedPackage(ids.a, 60);
    const h1 = await hold(ids.a, "ROOM3", 10);
    const h2 = await hold(ids.a, "ROOM4", 10);
    const [a1, a2] = [await authorize(ids.a, h1.id, "CONFIRM_BALANCE", 0, 60), await authorize(ids.a, h2.id, "CONFIRM_BALANCE", 0, 60)];
    const [r1, r2] = await Promise.all([run(a1, ids.a, h1.id), run(a2, ids.a, h2.id)]);
    assert.deepEqual([r1.status, r2.status].sort(), ["CONFIRMED", "INSUFFICIENT_BALANCE"]);
    assert.equal(await remaining(ids.a), 0);
  });

  test("הקוד אינו בלוגים או בתוצאות; ושגיאת כרטיס לא חושפת טוקן", async () => {
    const { captureConsole } = await import("@/ivr/test-harness");
    const card = await addCard(ids.a);
    const row = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: card.id } });
    const h = await hold(ids.a, "ROOM3", 10);
    const { result, output } = await captureConsole(async () => {
      const out: unknown[] = [];
      out.push(await authz.authorizeWithPin({ userId: ids.a, pin: "0000", appointmentId: h.id, action: "PAY_CARD", amountAgorot: 5200, packageMinutes: 0 }));
      const id = await authorize(ids.a, h.id, "PAY_CARD", 5200, 0);
      out.push(await run(id, ids.a, h.id));
      return out;
    });
    const dump = JSON.stringify(result);
    for (const secret of [PIN, "0000", row.token, SITE_PASSWORD]) {
      assert.ok(!dump.includes(secret) && !output.includes(secret), `נחשף ${secret}`);
    }
  });
});
