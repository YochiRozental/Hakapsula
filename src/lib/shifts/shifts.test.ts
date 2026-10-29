import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";

// בדיקות משמרות קבועות מול PostgreSQL מקומי ייעודי: יצירה אטומית, זכאות, תמחור, חיוב ראשון וחודשי, Cron, כישלונות, תקופת חסד,
// השעיה, סגירת יום, בקשות שינוי וביטול. רצות רק כש-SHIFTS_TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test. דוגמה:
//   SHIFTS_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_shifts_test npm test
const testUrl = process.env.SHIFTS_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) throw new Error("SHIFTS_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
}

const SECRET = "shifts-test-secret-0123456789";
const SITE_PASSWORD = "Site-Pass-9xQ!";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// "היום" הקבוע של הבדיקות (רביעי). התחלה ביום שני 15.2.2027: פברואר 2 מופעים, מרץ 5, אפריל 4. סיום ב-30.4
const NOW = new Date("2027-02-10T09:00:00Z");
const START = "2027-02-15";

describe("משמרות קבועות וחיוב חודשי: מול PostgreSQL מקומי", { skip: !testUrl && "SHIFTS_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let svc: typeof import("@/lib/shifts/schedule");
  let life: typeof import("@/lib/shifts/lifecycle");
  let bill: typeof import("@/lib/shifts/billing");
  let views: typeof import("@/lib/shifts/views");
  let gate: typeof import("@/lib/shifts/gate");
  let booking: typeof import("@/lib/booking");
  let payBooking: typeof import("@/lib/payments/booking-payment");
  let methods: typeof import("@/lib/payments/saved-methods");
  let hoursDb: typeof import("@/lib/opening-hours-db");
  let pw: typeof import("@/lib/password");
  let MockPaymentProvider: typeof import("@/lib/payments/mock-provider").MockPaymentProvider;
  let PrismaMockStore: typeof import("@/lib/payments/mock-store").PrismaMockStore;
  let jerusalemParts: typeof import("@/lib/opening-hours").jerusalemParts;
  let provider: InstanceType<typeof MockPaymentProvider>;
  const ids: Record<string, string> = {};
  let keyCounter = 0;
  const key = () => `key-${Date.now()}-${keyCounter++}-abcdefgh`;

  async function wipe() {
    await prisma.refund.deleteMany({});
    await prisma.shiftChangeRequest.deleteMany({});
    await prisma.shiftCharge.deleteMany({});
    await prisma.shiftOccurrence.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.cronRun.deleteMany({});
    await prisma.paymentAttempt.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.debtSettlement.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.appointment.deleteMany({});
    await prisma.mockProviderRecord.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.openingWindow.deleteMany({});
  }

  /** שעות פעילות רחבות (עד 23:00) כדי שגם משמרת ערב תתאים לשעות הפעילות */
  async function openLate(weekday: number, activity: "BOYS" | "GIRLS") {
    await hoursDb.replaceWeekday(weekday, [{ startMinutes: 8 * 60, endMinutes: 23 * 60, activity }], activity, false);
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = (await import("@/lib/prisma")) as { prisma: PrismaClient });
    svc = await import("@/lib/shifts/schedule");
    life = await import("@/lib/shifts/lifecycle");
    bill = await import("@/lib/shifts/billing");
    views = await import("@/lib/shifts/views");
    gate = await import("@/lib/shifts/gate");
    booking = await import("@/lib/booking");
    payBooking = await import("@/lib/payments/booking-payment");
    methods = await import("@/lib/payments/saved-methods");
    hoursDb = await import("@/lib/opening-hours-db");
    pw = await import("@/lib/password");
    ({ MockPaymentProvider } = await import("@/lib/payments/mock-provider"));
    ({ PrismaMockStore } = await import("@/lib/payments/mock-store"));
    ({ jerusalemParts } = await import("@/lib/opening-hours"));
    origCharge = MockPaymentProvider.prototype.chargeSavedMethod;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
  });

  beforeEach(async () => {
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
    provider = new MockPaymentProvider(SECRET, new PrismaMockStore(prisma));
    const passwordHash = await pw.hashPassword(SITE_PASSWORD);
    const mk = async (k: string, extra: Record<string, unknown> = {}) => {
      ids[k] = (await prisma.user.create({ data: { name: `sh ${k}`, email: `sh-${k}@test.local`, passwordHash, gender: "MALE", status: "APPROVED", canBookShifts: true, ...(extra as object) } as never })).id;
    };
    await mk("a");
    await mk("b");
    await mk("noPerm", { canBookShifts: false });
    await mk("blocked", { status: "BLOCKED" });
    await mk("pending", { status: "PENDING" });
    await mk("female", { gender: "FEMALE" });
    await mk("admin", { role: "ADMIN", canBookShifts: false });
    await mk("noCard");
    for (const k of ["a", "b", "blocked", "pending", "female", "noPerm"]) await addCard(ids[k]);
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "sh " } } });
    await prisma.$disconnect();
  });

  // ───────────── עזרים ─────────────
  async function addCard(userId: string) {
    const res = await methods.addMockCard({ userId, currentPassword: SITE_PASSWORD, provider });
    assert.equal(res.status, "OK");
  }
  type Over = Partial<Parameters<typeof svc.createShift>[0]>;
  const create = (userId: string, over: Over = {}) =>
    svc.createShift({ userId, roomKey: "ROOM3", weekday: 1, windowId: "MORNING", startDate: START, clientKey: key(), provider, now: NOW, ...over });
  async function createOk(userId = ids.a, over: Over = {}) {
    const res = await create(userId, over);
    assert.equal(res.status, "ACTIVE", JSON.stringify(res));
    return res.shiftId;
  }
  const cron = (now: Date, extra: Partial<Parameters<typeof bill.runMonthlyShiftBilling>[0]> = {}) =>
    bill.runMonthlyShiftBilling({ provider, trigger: "test", now, ...extra });
  const MARCH_1 = new Date("2027-03-01T05:00:00Z");
  const APRIL_1 = new Date("2027-04-01T05:00:00Z");
  const chargesOf = (shiftId: string) => prisma.shiftCharge.findMany({ where: { shiftId }, orderBy: { month: "asc" } });
  const chargeOf = (shiftId: string, month: string) => prisma.shiftCharge.findUniqueOrThrow({ where: { shiftId_month: { shiftId, month } } });
  const providerPays = () => prisma.mockProviderRecord.count({ where: { key: { startsWith: "pay:" } } });

  type ChargeFn = typeof MockPaymentProvider.prototype.chargeSavedMethod;
  let origCharge: ChargeFn;
  async function withCharge<T>(impl: ChargeFn, fn: () => Promise<T>) {
    const orig = MockPaymentProvider.prototype.chargeSavedMethod;
    MockPaymentProvider.prototype.chargeSavedMethod = impl;
    try {
      return await fn();
    } finally {
      MockPaymentProvider.prototype.chargeSavedMethod = orig;
    }
  }
  /** חיוב שהספק דוחה בוודאות: מחייב טוקן שנדחה, כך שהספק מחזיר כישלון אמיתי */
  const declineCharges: ChargeFn = async function (this: InstanceType<typeof MockPaymentProvider>, input) {
    const t = await this.issueSandboxToken();
    await this.declineToken(t.token);
    return origCharge.call(this, { ...input, token: t.token });
  };

  // ───────────── זכאות ─────────────

  test("זכאות נבדקת בשרת: בלי אישור מנהל, חסום או ממתין אי אפשר; מנהל מעניק ושולל; חוב פתוח אינו חוסם", async () => {
    for (const k of ["noPerm", "blocked", "pending"]) {
      await assert.rejects(() => create(ids[k]), { code: "FORBIDDEN" }, k);
    }
    await assert.rejects(() => create(ids.admin), { code: "FORBIDDEN" });
    assert.equal(await prisma.shift.count({}), 0);

    await assert.rejects(() => life.setShiftEligibility({ adminId: ids.a, userId: ids.noPerm, allowed: true }), { code: "FORBIDDEN" }, "לקוח אינו מעניק לעצמו");
    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.noPerm, allowed: true, now: NOW });
    const granted = await prisma.user.findUniqueOrThrow({ where: { id: ids.noPerm } });
    assert.deepEqual([granted.canBookShifts, granted.shiftEligibilityUpdatedById], [true, ids.admin]);
    await createOk(ids.noPerm);

    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.b, allowed: false });
    await assert.rejects(() => create(ids.b), { code: "FORBIDDEN" });
    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.b, allowed: true });

    // חוב פתוח אינו חוסם אוטומטית
    await prisma.debt.create({ data: { userId: ids.a, amountAgorot: 5200, createdById: ids.admin } });
    await createOk(ids.a, { roomKey: "ROOM4" });
  });

  test("לקוח ללא כרטיס שמור, או עם כרטיס Mock שאינו שמיש: אין אישור משמרת ואין שמירת משבצות", async () => {
    await life.setShiftEligibility({ adminId: ids.admin, userId: ids.noCard, allowed: true });
    await assert.rejects(() => create(ids.noCard), { code: "NO_PAYMENT_METHOD" });
    // כרטיס שנדחה אצל הספק אינו שמיש
    const row = await prisma.paymentMethod.findFirstOrThrow({ where: { userId: ids.a } });
    await provider.declineToken(row.token);
    await assert.rejects(() => create(ids.a), { code: "NO_PAYMENT_METHOD" });
    // כרטיס שנוצר כ-LIVE (לא sandbox) אינו נטען מול ספק Mock
    await prisma.paymentMethod.updateMany({ where: { userId: ids.a }, data: { environment: "LIVE" } });
    await assert.rejects(() => create(ids.a), { code: "NO_PAYMENT_METHOD" });
    const c = { shifts: await prisma.shift.count({}), appts: await prisma.appointment.count({}), pays: await prisma.payment.count({}) };
    assert.deepEqual(c, { shifts: 0, appts: 0, pays: 0 });
  });

  // ───────────── יצירה, תמחור ותקופה ─────────────

  test("יצירת משמרת לכל אחת מארבע המשבצות: מחיר מדויק, מופעים כהזמנות מאושרות, וחיוב ראשון של פברואר בלבד", async () => {
    await openLate(1, "BOYS");
    const expected: [string, string, number][] = [
      ["MORNING", "ROOM3", 2 * 16640],
      ["NOON", "ROOM4", 2 * 15600],
      ["AFTERNOON", "WORKSHOP", 2 * 15600],
      ["EVENING", "ROOM2", 2 * 11440],
    ];
    for (const [windowId, roomKey, firstCharge] of expected) {
      const res = await create(ids.a, { windowId, roomKey: roomKey as never });
      assert.deepEqual([res.status, res.status === "ACTIVE" && res.firstChargeAgorot], ["ACTIVE", firstCharge], windowId);
      const shift = await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId }, include: { occurrences: true, charges: true } });
      assert.equal(shift.status, "ACTIVE");
      assert.equal(shift.endDate, "2027-04-30");
      assert.equal(shift.occurrences.length, 11, `${windowId}: 11 ימי שני בין 15.2 ל-30.4`);
      assert.ok(shift.occurrences.every((o) => o.status === "SCHEDULED" && o.appointmentId));
      assert.equal(shift.charges.length, 1, "החיוב הראשון בלבד, לא חודשים עתידיים");
      assert.deepEqual([shift.charges[0].month, shift.charges[0].amountAgorot, shift.charges[0].occurrenceCount, shift.charges[0].isFirst, shift.charges[0].status], ["2027-02", firstCharge, 2, true, "PAID"]);
      const pay = await prisma.payment.findUniqueOrThrow({ where: { id: shift.charges[0].paymentId! } });
      assert.deepEqual([pay.purpose, pay.status, pay.amountAgorot, pay.environment], ["SHIFT_MONTH", "SUCCEEDED", firstCharge, "SANDBOX"]);
    }
    const appts = await prisma.appointment.findMany({ where: { source: "SHIFT" } });
    assert.equal(appts.length, 44);
    assert.ok(appts.every((a) => a.status === "CONFIRMED" && a.userId === ids.a));
    assert.equal(await providerPays(), 4, "ארבעה חיובים ראשונים בדיוק");
  });

  test("שעות המופעים בשעון ירושלים, כולל מעבר לשעון קיץ (26.3.2027) באמצע התקופה", async () => {
    const shiftId = await createOk(ids.a, { windowId: "NOON" });
    const occ = await prisma.shiftOccurrence.findMany({ where: { shiftId }, orderBy: { date: "asc" } });
    assert.ok(occ.some((o) => o.date < "2027-03-26") && occ.some((o) => o.date > "2027-03-26"));
    for (const o of occ) {
      assert.deepEqual([jerusalemParts(o.startTime).date, jerusalemParts(o.startTime).minutes, jerusalemParts(o.endTime).minutes], [o.date, 12 * 60 + 15, 16 * 60], o.date);
    }
  });

  test("התחלה באמצע החודש: החיוב הראשון כולל רק את המופעים שנותרו בחודש; חודש ראשון בלי מופעים = ללא חיוב", async () => {
    const mid = await createOk(ids.a, { startDate: "2027-02-17" }); // רביעי -> הראשון ב-22.2
    const ch = await chargeOf(mid, "2027-02");
    assert.deepEqual([ch.occurrenceCount, ch.amountAgorot], [1, 16640]);

    const none = await createOk(ids.b, { startDate: "2027-02-26", roomKey: "ROOM4" }); // שישי -> הראשון 1.3, אין מופע בפברואר
    const zero = await chargeOf(none, "2027-02");
    assert.deepEqual([zero.status, zero.amountAgorot, zero.occurrenceCount], ["WAIVED", 0, 0]);
    assert.equal(await prisma.payment.count({ where: { userId: ids.b } }), 0, "אין חיוב בספק על חודש ריק");
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: none } })).status, "ACTIVE");
  });

  test("מעבר שנה: תקופה דצמבר-פברואר ומופעי ינואר בחודש הנכון", async () => {
    const NOW2 = new Date("2026-12-10T09:00:00Z");
    const shiftId = await createOk(ids.a, { now: NOW2, startDate: "2026-12-14" });
    const occ = await prisma.shiftOccurrence.findMany({ where: { shiftId }, orderBy: { date: "asc" } });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).endDate, "2027-02-28");
    const byMonth = occ.reduce<Record<string, number>>((m, o) => ({ ...m, [o.month]: (m[o.month] ?? 0) + 1 }), {});
    assert.deepEqual(byMonth, { "2026-12": 3, "2027-01": 4, "2027-02": 4 });
    assert.deepEqual((await chargeOf(shiftId, "2026-12")).amountAgorot, 3 * 16640);
  });

  test("תאריך התחלה בעבר או רחוק מדי, ויום/משבצת לא תקינים נדחים", async () => {
    for (const startDate of ["2027-02-09", "2027-03-20", "not-a-date"]) await assert.rejects(() => create(ids.a, { startDate }), { code: "INVALID" }, startDate);
    await assert.rejects(() => create(ids.a, { weekday: 6 }), { code: "INVALID" });
    await assert.rejects(() => create(ids.a, { windowId: "MIDNIGHT" }), { code: "INVALID" });
    await assert.rejects(() => create(ids.a, { clientKey: "short" }), { code: "INVALID" });
    assert.equal(await prisma.shift.count({}), 0);
  });

  test("שעות הפעילות והמסלול נאכפים: ערב מחוץ לשעות ברירת המחדל נדחה; לקוחה במסלול בנות לא מזמינה יום בנים", async () => {
    await assert.rejects(() => create(ids.a, { windowId: "EVENING" }), (e: { code: string; details?: { conflicts: unknown[] } }) => e.code === "CONFLICT" && (e.details?.conflicts.length ?? 0) === 11);
    await assert.rejects(() => create(ids.female), { code: "CONFLICT" }, "יום שני הוא מסלול בנים");
    await createOk(ids.female, { weekday: 2 }); // יום שלישי: מסלול בנות
    assert.equal(await prisma.shift.count({}), 1);
  });

  // ───────────── ימים סגורים ושעות פעילות ─────────────

  test("יום שנסגר במפורש לפני היצירה: המופע מדולג וללא חיוב; שינוי רגיל בשעות אינו מבטל משמרת קיימת", async () => {
    await hoursDb.replaceDate("2027-03-08", { closed: true, note: "חג" });
    const shiftId = await createOk();
    const skipped = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId, date: "2027-03-08" } } });
    assert.deepEqual([skipped.status, skipped.appointmentId], ["SKIPPED_CLOSED_DAY", null]);
    await cron(MARCH_1);
    assert.deepEqual([(await chargeOf(shiftId, "2027-03")).occurrenceCount, (await chargeOf(shiftId, "2027-03")).amountAgorot], [4, 4 * 16640], "4 מופעים בלבד");

    // שינוי רגיל בשעות (יום שני 09:00–10:00) אינו נוגע במשמרת
    await hoursDb.replaceWeekday(1, [{ startMinutes: 9 * 60, endMinutes: 10 * 60, activity: "BOYS" }], "BOYS", false);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), 10);
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), 10);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");
  });

  test("סגירת יום מפורשת אחרי שהחודש שולם: דילוג, הזמנה מבוטלת, החדר מתפנה, החזר חלקי פעם אחת בלבד", async () => {
    const shiftId = await createOk();
    await cron(MARCH_1);
    const paid = await chargeOf(shiftId, "2027-03");
    assert.equal(paid.status, "PAID");

    await assert.rejects(() => life.applyDayClosure({ date: "2027-03-15", adminId: ids.a, provider }), { code: "FORBIDDEN" });
    const first = await life.applyDayClosure({ date: "2027-03-15", adminId: ids.admin, provider });
    assert.deepEqual([first.skipped, first.refundedAgorot], [1, 16640]);
    const occ = await prisma.shiftOccurrence.findUniqueOrThrow({ where: { shiftId_date: { shiftId, date: "2027-03-15" } } });
    assert.deepEqual([occ.status, occ.refundedAgorot], ["SKIPPED_CLOSED_DAY", 16640]);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: occ.appointmentId! } })).status, "CANCELLED");
    assert.equal((await chargeOf(shiftId, "2027-03")).refundedAgorot, 16640);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paid.paymentId! } });
    assert.equal((await provider.getPaymentStatus(payment.providerPaymentId!)).refundedAgorot, 16640);

    const again = await life.applyDayClosure({ date: "2027-03-15", adminId: ids.admin, provider });
    assert.deepEqual([again.skipped, again.refundedAgorot], [0, 0], "אין החזר כפול");
    assert.equal((await provider.getPaymentStatus(payment.providerPaymentId!)).refundedAgorot, 16640);
    // החדר פנוי להזמנה רגילה באותה שעה
    const start = occ.startTime;
    const walkIn = await booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: start, endTime: new Date(start.getTime() + HOUR), source: "ADMIN" });
    assert.equal(walkIn.status, "CONFIRMED");
    // ההיסטוריה נשמרה (המופע והחיוב לא נמחקו)
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId } }), 11);
  });

  test("סגירת יום לפני שהחודש חויב: ללא חיוב על המופע; חיוב שנכשל מופחת", async () => {
    const shiftId = await createOk();
    const summary = await life.applyDayClosure({ date: "2027-04-12", adminId: ids.admin, provider });
    assert.deepEqual([summary.skipped, summary.refundedAgorot], [1, 0]);
    await cron(APRIL_1);
    assert.deepEqual([(await chargeOf(shiftId, "2027-04")).occurrenceCount, (await chargeOf(shiftId, "2027-04")).amountAgorot], [3, 3 * 16640]);

    // חיוב מרץ שנכשל ואז יום נסגר: הסכום מופחת במקום להחזיר כסף שלא נגבה
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    await withCharge(declineCharges, () => cron(MARCH_1));
    assert.equal((await chargeOf(b, "2027-03")).status, "FAILED");
    // שתי המשמרות מופיעות ב-22.3: של a כבר שולמה במרץ (החזר), ושל b נכשלה (הסכום מופחת במקום החזר)
    const closure = await life.applyDayClosure({ date: "2027-03-22", adminId: ids.admin, provider });
    assert.deepEqual([closure.refundedAgorot, closure.creditedAgorot], [16640, 16640]);
    const reduced = await chargeOf(b, "2027-03");
    assert.deepEqual([reduced.occurrenceCount, reduced.amountAgorot], [4, 4 * 16640]);
  });

  // ───────────── התנגשויות ומקביליות ─────────────

  test("התנגשות עם הזמנה רגילה, החזקה פעילה, משמרת אחרת וחדר משולב: נדחה, ולא נוצר דבר", async () => {
    const monday = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00+02:00`);
    // הזמנה רגילה במרץ
    await booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: monday("2027-03-08", 9), endTime: monday("2027-03-08", 10), source: "ADMIN" });
    await assert.rejects(() => create(ids.a), (e: { code: string; details?: { conflicts: { date: string }[] } }) => e.code === "CONFLICT" && e.details!.conflicts.some((c) => c.date === "2027-03-08"));
    assert.deepEqual([await prisma.shift.count({}), await prisma.appointment.count({ where: { source: "SHIFT" } }), await prisma.payment.count({})], [0, 0, 0]);

    // החזקה פעילה (בשעון הבדיקה) חוסמת; החזקה שפגה אינה חוסמת
    await booking.createBookingHold({ userId: ids.b, roomKey: "ROOM4", startTime: monday("2027-03-22", 13), endTime: monday("2027-03-22", 14), source: "WEB", now: NOW });
    await assert.rejects(() => create(ids.a, { roomKey: "ROOM4", windowId: "NOON" }), { code: "CONFLICT" });
    await prisma.appointment.updateMany({ where: { status: "PENDING_PAYMENT" }, data: { holdExpiresAt: new Date(NOW.getTime() - 1000) } });
    await createOk(ids.a, { roomKey: "ROOM4", windowId: "NOON" });

    // משמרת אחרת באותו חדר/יום/משבצת, וחדר משולב שמתנגש בחדר 1
    await assert.rejects(() => create(ids.b, { roomKey: "ROOM4", windowId: "NOON" }), { code: "CONFLICT" });
    await createOk(ids.b, { roomKey: "ROOM1" });
    await assert.rejects(() => create(ids.a, { roomKey: "ROOM1_2" }), { code: "CONFLICT" });
  });

  test("שתי בקשות יצירה מקבילות לאותו חדר, יום ומשבצת: משמרת אחת בלבד, ללא חפיפה", async () => {
    for (let round = 0; round < 3; round++) {
      await wipe();
      await prisma.paymentMethod.deleteMany({});
      await addCard(ids.a);
      await addCard(ids.b);
      const results = await Promise.allSettled([create(ids.a), create(ids.b)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `סבב ${round}`);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(rejected[0].reason.code, "CONFLICT");
      assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), 11);
      assert.equal(await prisma.shift.count({ where: { status: "ACTIVE" } }), 1);
    }
  });

  test("שתי משמרות מקבילות בחדרים שונים מצליחות; ולחיצה כפולה (אותו מפתח) מחזירה את אותה משמרת בלי חיוב כפול", async () => {
    const [x, y] = await Promise.all([create(ids.a, { roomKey: "ROOM3" }), create(ids.b, { roomKey: "ROOM4" })]);
    assert.deepEqual([x.status, y.status], ["ACTIVE", "ACTIVE"]);

    const k = key();
    const results = await Promise.all(Array.from({ length: 4 }, () => create(ids.a, { clientKey: k, roomKey: "WORKSHOP" })));
    assert.equal(new Set(results.map((r) => r.shiftId)).size, 1);
    assert.equal(await prisma.shift.count({ where: { roomId: (await prisma.room.findUniqueOrThrow({ where: { key: "WORKSHOP" } })).id } }), 1);
    assert.equal(await prisma.payment.count({ where: { userId: ids.a } }), 2, "חיוב ראשון אחד לכל משמרת");
  });

  // ───────────── כישלונות בחיוב הראשון ─────────────

  test("חיוב ראשון שנכשל בוודאות: המשמרת לא מאושרת והמשבצות משוחררות", async () => {
    const res = await withCharge(declineCharges, () => create(ids.a));
    assert.equal(res.status, "CHARGE_FAILED");
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId } });
    assert.equal(shift.status, "CANCELLED");
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), 0);
    assert.equal((await chargeOf(res.shiftId, "2027-02")).status, "FAILED");
    assert.equal((await prisma.payment.findFirstOrThrow({})).status, "FAILED");
    await createOk(ids.b); // החדר פנוי
  });

  test("חיוב ראשון במצב לא ידוע: המשבצות שמורות, אין חיוב חוזר אוטומטי, ובירור מנהל מכריע", async () => {
    let calls = 0;
    const counting: ChargeFn = async () => {
      calls++;
      throw new Error("network down");
    };
    const res = await withCharge(counting, () => create(ids.a));
    assert.equal(res.status, "PENDING_REVIEW");
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId } })).status, "PENDING");
    assert.equal((await chargeOf(res.shiftId, "2027-02")).status, "UNKNOWN");
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), 11, "המשבצות שמורות");
    await assert.rejects(() => create(ids.b), { code: "CONFLICT" }, "שמורות גם מול אחרים");

    // ריצת Cron ובקשה חוזרת לא מחייבות בעיוורון
    await withCharge(counting, () => cron(MARCH_1));
    await withCharge(counting, () => create(ids.a, { clientKey: key() }).catch(() => undefined));
    assert.equal(calls, 1, "ניסיון חיוב יחיד");
    const unknownId = (await chargeOf(res.shiftId, "2027-02")).id;
    await assert.rejects(() => life.resolveUnknownCharge({ chargeId: unknownId, adminId: ids.a, outcome: "PAID" }), { code: "FORBIDDEN" });
    await life.resolveUnknownCharge({ chargeId: unknownId, adminId: ids.admin, outcome: "PAID", now: NOW });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: res.shiftId } })).status, "ACTIVE");

    // והכרעה "לא חויב" משחררת את המשבצות
    const other = await withCharge(counting, () => create(ids.b, { roomKey: "ROOM4" }));
    await life.resolveUnknownCharge({ chargeId: (await chargeOf(other.shiftId, "2027-02")).id, adminId: ids.admin, outcome: "NOT_CHARGED", now: NOW });
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: other.shiftId } })).status, "CANCELLED");
    assert.equal(await prisma.appointment.count({ where: { roomId: (await prisma.room.findUniqueOrThrow({ where: { key: "ROOM4" } })).id, status: "CONFIRMED" } }), 0);
  });

  // ───────────── חיוב חודשי ו-Cron ─────────────

  test("חיוב חודשי: מרץ (5 מופעים) ואפריל (4 מופעים) בסכומים מדויקים, פעם אחת לכל חודש, והרצה כפולה לא מחייבת", async () => {
    const shiftId = await createOk();
    assert.equal((await cron(new Date("2027-02-20T05:00:00Z"))).outcome, "DONE");
    assert.equal((await chargesOf(shiftId)).length, 1, "פברואר כבר חויב; אין חיוב מוקדם של חודשים עתידיים");

    const r1 = await cron(MARCH_1);
    assert.ok(r1.outcome === "DONE" && r1.status === "SUCCEEDED" && r1.summary.charged === 1);
    const march = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([march.status, march.occurrenceCount, march.amountAgorot, march.attempt], ["PAID", 5, 83200, 1]);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: march.paymentId! } })).idempotencyKey, `shiftcharge:${shiftId}:2027-03:a1`);

    const payments = await prisma.payment.count({});
    const r2 = await cron(MARCH_1);
    assert.ok(r2.outcome === "DONE" && r2.summary.charged === 0);
    await cron(new Date("2027-03-15T05:00:00Z"));
    assert.equal(await prisma.payment.count({}), payments, "הרצות חוזרות באותו חודש: אין חיוב נוסף");
    assert.equal(await providerPays(), 2);

    await cron(APRIL_1);
    const april = await chargeOf(shiftId, "2027-04");
    assert.deepEqual([april.status, april.occurrenceCount, april.amountAgorot], ["PAID", 4, 66560]);
    assert.equal((await chargesOf(shiftId)).length, 3);
    // סיום: אחרי סוף התקופה והכול שולם
    await cron(new Date("2027-05-02T05:00:00Z"));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ENDED");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, date: { gt: "2027-04-30" } } }), 0);
  });

  test("חודש שהוחמץ מזוהה ומחויב בריצה הבאה", async () => {
    const shiftId = await createOk();
    const r = await cron(new Date("2027-04-05T05:00:00Z")); // מרץ לא רץ מעולם
    assert.ok(r.outcome === "DONE" && r.summary.missedFound === 1 && r.summary.charged === 2, JSON.stringify(r));
    assert.deepEqual((await chargesOf(shiftId)).map((c) => [c.month, c.status]), [["2027-02", "PAID"], ["2027-03", "PAID"], ["2027-04", "PAID"]]);
  });

  test("הרצות Cron מקבילות וריצה נטושה: חיוב יחיד לכל חודש, ו-RUNNING ישנה נלקחת", async () => {
    const shiftId = await createOk();
    const results = await Promise.all([cron(MARCH_1), cron(MARCH_1), cron(MARCH_1)]);
    assert.ok(results.every((r) => r.outcome === "ALREADY_RUNNING" || r.outcome === "DONE"));
    assert.equal(await prisma.payment.count({ where: { purpose: "SHIFT_MONTH" } }), 2);
    assert.equal((await chargeOf(shiftId, "2027-03")).attempt, 1);

    await prisma.cronRun.deleteMany({});
    await prisma.cronRun.create({ data: { job: "shift-billing", period: "2027-03", trigger: "dead", status: "RUNNING", startedAt: new Date(MARCH_1.getTime() - 3 * HOUR) } });
    const live = await cron(MARCH_1);
    assert.equal(live.outcome, "DONE");
    assert.equal((await prisma.cronRun.findFirstOrThrow({ where: { trigger: "dead" } })).status, "FAILED");
    await prisma.cronRun.create({ data: { job: "shift-billing", period: "2027-03", trigger: "fresh", status: "RUNNING", startedAt: MARCH_1 } });
    assert.equal((await cron(MARCH_1)).outcome, "ALREADY_RUNNING");
  });

  test("הרצות מתועדות; סריקה נפרדת מביצוע; כישלון חלקי בפריט אחד לא עוצר את האחרים", async () => {
    const a = await createOk(ids.a);
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    const scan = await bill.scanDueCharges(prisma, MARCH_1);
    assert.deepEqual(scan.due.map((d) => [d.shiftId, d.month, d.kind]).sort(), [[a, "2027-03", "MONTHLY"], [b, "2027-03", "MONTHLY"]].sort());
    assert.equal(await prisma.shiftCharge.count({ where: { month: "2027-03" } }), 0, "הסריקה לא כתבה כלום");

    // הכרטיס של b נמחק: החיוב שלו נכשל בוודאות, ושל a מצליח
    await prisma.paymentMethod.updateMany({ where: { userId: ids.b }, data: { active: false } });
    const run = await cron(MARCH_1);
    assert.ok(run.outcome === "DONE");
    if (run.outcome === "DONE") assert.deepEqual([run.summary.charged, run.summary.failed], [1, 1]);
    assert.equal((await chargeOf(a, "2027-03")).status, "PAID");
    assert.deepEqual([(await chargeOf(b, "2027-03")).status, (await chargeOf(b, "2027-03")).failureCode], ["FAILED", "no_usable_method"]);
    const row = await prisma.cronRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    assert.ok(row.finishedAt && row.status === "SUCCEEDED" && (row.summary as { charged: number }).charged === 1);
    assert.equal((await views.recentCronRuns(5)).length >= 1, true);
  });

  test("התאוששות: ריצה שנקטעה אחרי חיוב אצל הספק מסתיימת בלי חיוב שני; נקטעה לפני הספק -> לא ידוע, בלי חיוב עיוור", async () => {
    const shiftId = await createOk();
    // ריצה שנקטעה אחרי שהספק חייב: תשלום אצל הספק עם אותו מפתח, אבל החיוב אצלנו נשאר PENDING
    const token = (await prisma.paymentMethod.findFirstOrThrow({ where: { userId: ids.a } })).token;
    const key1 = bill.chargeKey(shiftId, "2027-03", 1);
    const charged = await provider.chargeSavedMethod({ token, amountAgorot: 83200, currency: "ILS", description: "x", idempotencyKey: key1, customerRef: ids.a });
    const pay = await prisma.payment.create({
      data: { userId: ids.a, purpose: "SHIFT_MONTH", amountAgorot: 83200, status: "PENDING", environment: "SANDBOX", provider: "mock", idempotencyKey: key1, providerPaymentId: charged.providerPaymentId },
    });
    await prisma.shiftCharge.create({ data: { shiftId, month: "2027-03", amountAgorot: 83200, occurrenceCount: 5, status: "PENDING", attempt: 1, claimedAt: new Date(MARCH_1.getTime() - HOUR), paymentId: pay.id } });
    const before = await providerPays();
    await cron(MARCH_1);
    assert.equal((await chargeOf(shiftId, "2027-03")).status, "PAID");
    assert.equal(await providerPays(), before, "לא בוצע חיוב שני אצל הספק");

    // ריצה שנקטעה אחרי יצירת התשלום אך לפני שהגיע לספק: לא ידוע, ללא חיוב
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    const beforeBlind = await providerPays();
    const key2 = bill.chargeKey(b, "2027-03", 1);
    await prisma.payment.create({ data: { userId: ids.b, purpose: "SHIFT_MONTH", amountAgorot: 83200, status: "PENDING", environment: "SANDBOX", provider: "mock", idempotencyKey: key2 } });
    await prisma.shiftCharge.create({ data: { shiftId: b, month: "2027-03", amountAgorot: 83200, occurrenceCount: 5, status: "PENDING", attempt: 1, claimedAt: new Date(MARCH_1.getTime() - HOUR) } });
    await cron(MARCH_1);
    const c = await chargeOf(b, "2027-03");
    assert.deepEqual([c.status, c.failureCode], ["UNKNOWN", "interrupted"]);
    assert.equal(await providerPays(), beforeBlind, "גם כאן אין חיוב עיוור");
  });

  test("תקלת רשת בחיוב החודשי: UNKNOWN, ללא חיוב חוזר בריצות הבאות, עד בירור", async () => {
    const shiftId = await createOk();
    let calls = 0;
    const counting: ChargeFn = async () => {
      calls++;
      throw new Error("timeout");
    };
    await withCharge(counting, () => cron(MARCH_1));
    assert.equal((await chargeOf(shiftId, "2027-03")).status, "UNKNOWN");
    await withCharge(counting, () => cron(new Date("2027-03-02T05:00:00Z")));
    await withCharge(counting, () => cron(new Date("2027-03-20T05:00:00Z")));
    assert.equal(calls, 1);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE", "לא מושעית בגלל מצב לא ידוע");
    const unknownCharge = await chargeOf(shiftId, "2027-03");
    await assert.rejects(() => life.retryChargeAsAdmin({ chargeId: unknownCharge.id, adminId: ids.admin, provider }), { code: "CONFLICT" });
    const r = await cron(new Date("2027-03-20T05:00:00Z"));
    assert.ok(r.outcome === "DONE" && r.summary.needsReview === 1);
  });

  // ───────────── כישלון, חסד והשעיה ─────────────

  test("כישלון חיוב חודשי: תקופת חסד של 7 ימים (המשמרת פעילה), ניסיון חוזר פעם ביום, ואז השעיה בלי שחרור משבצות", async () => {
    const shiftId = await createOk();
    await withCharge(declineCharges, () => cron(MARCH_1));
    const failed = await chargeOf(shiftId, "2027-03");
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.graceUntil!.getTime() - MARCH_1.getTime(), 7 * DAY);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");

    // אותו יום: אין ניסיון נוסף. יום אחרי: ניסיון חוזר (נכשל שוב), המשמרת עדיין פעילה, ותקופת החסד לא התארכה
    await withCharge(declineCharges, () => cron(new Date(MARCH_1.getTime() + 2 * HOUR)));
    assert.equal((await chargeOf(shiftId, "2027-03")).attempt, 1);
    await withCharge(declineCharges, () => cron(new Date(MARCH_1.getTime() + DAY + HOUR)));
    const retried = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([retried.status, retried.attempt], ["FAILED", 2]);
    assert.equal(retried.graceUntil!.getTime(), failed.graceUntil!.getTime());
    assert.equal((await prisma.payment.count({ where: { purpose: "SHIFT_MONTH", status: "FAILED" } })), 2);
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "ACTIVE");

    // תקופת החסד חלפה בלי הסדרה -> SUSPENDED. המשבצות נשמרות, אין ביטול
    const r = await withCharge(declineCharges, () => cron(new Date(MARCH_1.getTime() + 7 * DAY + HOUR)));
    assert.ok(r.outcome === "DONE" && r.summary.suspended === 1);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.deepEqual([shift.status, shift.suspensionReason], ["SUSPENDED", "payment_failed:2027-03"]);
    assert.equal(await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }), 11, "המשבצות נשמרות");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), 11);
    await assert.rejects(() => create(ids.b), { code: "CONFLICT" }, "המשבצת מושעית אך חסומה לאחרים");
    const view = (await views.getMyShifts({ userId: ids.a, provider, now: new Date(MARCH_1.getTime() + 8 * DAY) })).shifts[0];
    assert.deepEqual([view.status, view.usable], ["SUSPENDED", false]);

    // משמרת מושעית אינה מחויבת בחודשים הבאים
    await cron(APRIL_1);
    assert.equal((await chargesOf(shiftId)).some((c) => c.month === "2027-04"), false);
  });

  test("כישלון שהוסדר בתקופת החסד מבטל אותה; חידוש מושעית מחייב הסדרה או ויתור מפורש של מנהל", async () => {
    const shiftId = await createOk();
    await withCharge(declineCharges, () => cron(MARCH_1));
    const r = await cron(new Date(MARCH_1.getTime() + DAY + HOUR)); // כרטיס תקין: הניסיון החוזר מצליח
    assert.ok(r.outcome === "DONE" && r.summary.retriedPaid === 1);
    const paid = await chargeOf(shiftId, "2027-03");
    assert.deepEqual([paid.status, paid.graceUntil], ["PAID", null]);

    // השעיה, ואז חידוש
    const b = await createOk(ids.b, { roomKey: "ROOM4" });
    await withCharge(declineCharges, () => cron(APRIL_1));
    await withCharge(declineCharges, () => cron(new Date(APRIL_1.getTime() + 8 * DAY)));
    assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: b } })).status, "SUSPENDED");
    await assert.rejects(() => life.resumeShift({ shiftId: b, adminId: ids.a }), { code: "FORBIDDEN" });
    await assert.rejects(() => life.resumeShift({ shiftId: b, adminId: ids.admin }), { code: "CONFLICT" }, "חוב לא מוסדר");

    // ניסיון חוזר ע"י מנהל מסדיר את החיובים אך אינו מחדש את המשמרת בעצמו: חידוש הוא החלטה נפרדת
    const failedCharges = await prisma.shiftCharge.findMany({ where: { shiftId: b, status: "FAILED" } });
    assert.equal(failedCharges.length, 2, "מרץ (שהוחמץ) ואפריל");
    for (const failedCharge of failedCharges) {
      const retried = await life.retryChargeAsAdmin({ chargeId: failedCharge.id, adminId: ids.admin, provider, now: new Date(APRIL_1.getTime() + 9 * DAY) });
      assert.equal(retried.outcome, "PAID");
      assert.equal((await prisma.shift.findUniqueOrThrow({ where: { id: b } })).status, "SUSPENDED");
    }
    await life.resumeShift({ shiftId: b, adminId: ids.admin, now: new Date(APRIL_1.getTime() + 9 * DAY) });
    const resumed = await prisma.shift.findUniqueOrThrow({ where: { id: b } });
    assert.deepEqual([resumed.status, resumed.suspendedAt, resumed.resumedById], ["ACTIVE", null, ids.admin]);

    // ויתור מפורש: מסמן את החיוב כמוותר ומחדש
    const c = await createOk(ids.a, { roomKey: "WORKSHOP" });
    await withCharge(declineCharges, () => cron(APRIL_1));
    await withCharge(declineCharges, () => cron(new Date(APRIL_1.getTime() + 8 * DAY)));
    const res = await life.resumeShift({ shiftId: c, adminId: ids.admin, waiveUnpaid: true, note: "הסכמה" });
    assert.ok(res.waived >= 1);
    assert.equal((await prisma.shiftCharge.findFirstOrThrow({ where: { shiftId: c, status: "WAIVED" } })).resolvedById, ids.admin);
  });

  // ───────────── בקשות שינוי וביטול ─────────────

  test("בקשת לקוח אינה משנה דבר: כפילות נדחית, משמרת של אחר מוסתרת, ודחיית מנהל משאירה הכול כפי שהיה", async () => {
    const shiftId = await createOk();
    const snapshot = async () => ({
      shift: await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } }),
      scheduled: await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }),
      confirmed: await prisma.appointment.count({ where: { source: "SHIFT", status: "CONFIRMED" } }),
    });
    const before = await snapshot();

    const cancelReq = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL", reason: "עוברת דירה" });
    assert.equal(cancelReq.status, "PENDING");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" } }), { code: "CONFLICT" }, "בקשה פתוחה אחת");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.b, shiftId, kind: "CANCEL" }), { code: "NOT_FOUND" });
    assert.deepEqual(await snapshot(), before, "הבקשה לא שינתה כלום");
    assert.equal(await prisma.refund.count({}), 0, "אין החזר אוטומטי מבקשת לקוח");

    await assert.rejects(() => life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.a, decision: "REJECT", provider }), { code: "FORBIDDEN" });
    const rejected = await life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.admin, decision: "REJECT", note: "לא מאושר", provider });
    assert.equal(rejected.status, "REJECTED");
    assert.deepEqual(await snapshot(), before);
    const stored = await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: cancelReq.id } });
    assert.deepEqual([stored.status, stored.decidedById, stored.decisionNote], ["REJECTED", ids.admin, "לא מאושר"]);
    await assert.rejects(() => life.decideShiftRequest({ requestId: cancelReq.id, adminId: ids.admin, decision: "REJECT", provider }), { code: "CONFLICT" }, "כבר טופלה");
    // אחרי דחייה אפשר להגיש בקשה חדשה
    await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" } });
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: {} }), { code: "INVALID" }, "שינוי בלי פירוט");
    await assert.rejects(() => life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "AFTERNOON" } }), { code: "CONFLICT" }, "כבר יש בקשה פתוחה");
  });

  test("אישור בקשת ביטול: מופעים עתידיים מהחודש שטרם שולם מבוטלים, חודשים ששולמו נשארים בלי החזר, וההיסטוריה נשמרת", async () => {
    const shiftId = await createOk();
    await cron(MARCH_1); // מרץ שולם
    const req = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL" });
    const res = await life.decideShiftRequest({ requestId: req.id, adminId: ids.admin, decision: "APPROVE", provider, now: new Date("2027-03-10T09:00:00Z") });
    assert.deepEqual([res.status, res.appliedFrom, res.cancelledOccurrences], ["APPROVED", "2027-04-01", 4]);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.equal(shift.status, "CANCELLED");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "CANCELLED" } }), 4);
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), 7, "פברואר ומרץ נשארו");
    assert.equal(await prisma.refund.count({}), 0, "בלי החזר אלא אם המנהל ביקש");
    await cron(APRIL_1);
    assert.equal((await chargesOf(shiftId)).some((c) => c.month === "2027-04"), false, "אין חיוב אחרי ביטול");
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId } }), 11);
  });

  test("אישור ביטול עם החזר מפורש לחודש ששולם: החזר חלקי למופעים שבוטלו, פעם אחת", async () => {
    const shiftId = await createOk();
    await cron(MARCH_1);
    const req = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CANCEL" });
    const res = await life.decideShiftRequest({
      requestId: req.id, adminId: ids.admin, decision: "APPROVE", effectiveFrom: "2027-03-22", refundCharged: true, provider, now: new Date("2027-03-10T09:00:00Z"),
    });
    assert.equal(res.cancelledOccurrences, 2 + 4, "22.3 ו-29.3, ואחריהם אפריל");
    assert.equal(res.adjust?.refundedAgorot, 2 * 16640);
    const march = await chargeOf(shiftId, "2027-03");
    assert.equal(march.refundedAgorot, 2 * 16640);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: march.paymentId! } });
    assert.equal((await provider.getPaymentStatus(payment.providerPaymentId!)).refundedAgorot, 2 * 16640);
  });

  test("אישור בקשת שינוי: מוחלף באטומיות מהחודש שטרם שולם; התנגשות או חודש ששולם מבטלים הכול", async () => {
    const shiftId = await createOk();
    await cron(MARCH_1);
    const now = new Date("2027-03-10T09:00:00Z");

    // שינוי לחודש ששולם נדחה
    const paidReq = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { windowId: "NOON" }, requestedFrom: "2027-03-22" });
    await assert.rejects(() => life.decideShiftRequest({ requestId: paidReq.id, adminId: ids.admin, decision: "APPROVE", provider, now }), { code: "CONFLICT" });
    assert.equal((await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: paidReq.id } })).status, "PENDING");
    await life.decideShiftRequest({ requestId: paidReq.id, adminId: ids.admin, decision: "REJECT", provider, now });

    // התנגשות בחדר החדש: הכול מתבטל, המשמרת והבקשה כפי שהיו
    await booking.createAppointment({ userId: ids.b, roomKey: "ROOM4", startTime: new Date("2027-04-12T13:00:00+03:00"), endTime: new Date("2027-04-12T14:00:00+03:00"), source: "ADMIN" });
    const blocked = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { roomKey: "ROOM4", windowId: "NOON" } });
    await assert.rejects(() => life.decideShiftRequest({ requestId: blocked.id, adminId: ids.admin, decision: "APPROVE", provider, now }), { code: "CONFLICT" });
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, status: "SCHEDULED" } }), 11, "שום מופע לא שונה");
    assert.equal((await prisma.shiftChangeRequest.findUniqueOrThrow({ where: { id: blocked.id } })).status, "PENDING");
    await life.decideShiftRequest({ requestId: blocked.id, adminId: ids.admin, decision: "REJECT", provider, now });

    // שינוי תקין: משבצת צהריים בחדר 4 מאפריל
    await prisma.appointment.updateMany({ where: { source: "ADMIN" }, data: { status: "CANCELLED" } });
    const ok = await life.createShiftRequest({ userId: ids.a, shiftId, kind: "CHANGE", proposed: { roomKey: "ROOM4", windowId: "NOON" } });
    const res = await life.decideShiftRequest({ requestId: ok.id, adminId: ids.admin, decision: "APPROVE", provider, now });
    assert.deepEqual([res.status, res.appliedFrom, res.cancelledOccurrences, res.createdOccurrences], ["APPROVED", "2027-04-01", 4, 4]);
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { room: true } });
    assert.deepEqual([shift.room.key, shift.windowId, shift.occurrencePriceAgorot], ["ROOM4", "NOON", 15600]);
    const april = await prisma.shiftOccurrence.findMany({ where: { shiftId, month: "2027-04", status: "SCHEDULED" } });
    assert.equal(april.length, 4);
    assert.ok(april.every((o) => o.priceAgorot === 15600 && jerusalemParts(o.startTime).minutes === 12 * 60 + 15));
    assert.equal(await prisma.shiftOccurrence.count({ where: { shiftId, month: "2027-03", status: "SCHEDULED" } }), 5, "מרץ לא שונה");
    await cron(APRIL_1);
    assert.equal((await chargeOf(shiftId, "2027-04")).amountAgorot, 4 * 15600, "החיוב החודשי לפי המופעים החדשים");
  });

  // ───────────── שער ורגרסיה ─────────────

  test("שער סגור כברירת מחדל: בלי SHIFTS_ENABLED או בלי ספק תקף אין ספק משמרות", () => {
    assert.equal(gate.getShiftsProvider({}), null);
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "true" }), null, "דגל פתוח בלי ספק תקף");
    assert.equal(gate.getShiftsProvider({ SHIFTS_ENABLED: "false", PAYMENT_PROVIDER: "mock", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_MOCK_ENABLED: "true", PAYMENT_WEBHOOK_SECRET: SECRET, DATABASE_URL: testUrl } as never), null);
    const open = gate.getShiftsProvider({ SHIFTS_ENABLED: "true", PAYMENT_PROVIDER: "mock", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_MOCK_ENABLED: "true", PAYMENT_WEBHOOK_SECRET: SECRET, DATABASE_URL: testUrl } as never);
    assert.equal(open?.name, "mock");
    // בסביבה חיה (production) ה-Mock נשאר חסום גם עם כל הדגלים
    assert.equal(
      gate.getShiftsProvider({ NODE_ENV: "production", SHIFTS_ENABLED: "true", PAYMENT_PROVIDER: "mock", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_MOCK_ENABLED: "true", PAYMENT_WEBHOOK_SECRET: SECRET, DATABASE_URL: testUrl } as never),
      null
    );
  });

  test("רגרסיה: הזמנות רגילות, תשלומי הזמנה וביטולים ממשיכים לעבוד; מופע משמרת אינו ניתן לביטול בודד ואינו ניתן לתפיסה", async () => {
    const shiftId = await createOk();
    const occ = await prisma.shiftOccurrence.findFirstOrThrow({ where: { shiftId }, orderBy: { date: "asc" } });
    // מופע המשמרת חוסם את החדר גם להזמנה רגילה ולהחזקה
    await assert.rejects(() => booking.createAppointment({ userId: ids.b, roomKey: "ROOM3", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB" }), booking.BookingError);
    await assert.rejects(() => booking.createBookingHold({ userId: ids.b, roomKey: "ROOM3", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB", now: NOW }), booking.BookingError);
    // ביטול בודד נחסם בשני המסלולים (שינוי/ביטול מחייבים אישור מנהל)
    await assert.rejects(() => booking.cancelAppointment(occ.appointmentId!, { id: ids.a, role: "CLIENT" }), /משמרת קבועה/);
    await assert.rejects(() => booking.cancelAppointment(occ.appointmentId!, { id: ids.admin, role: "ADMIN" }), /משמרת קבועה/);
    await assert.rejects(() => payBooking.cancelBooking({ appointmentId: occ.appointmentId!, requester: { id: ids.a, role: "CLIENT" }, provider }), { code: "CONFLICT" });
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: occ.appointmentId! } })).status, "CONFIRMED");

    // הזמנה רגילה בחדר אחר: יצירה וביטול כרגיל
    const regular = await booking.createAppointment({ userId: ids.b, roomKey: "ROOM4", startTime: occ.startTime, endTime: new Date(occ.startTime.getTime() + HOUR), source: "WEB" });
    assert.equal(regular.status, "CONFIRMED");
    assert.equal((await booking.cancelAppointment(regular.id, { id: ids.b, role: "CLIENT" })).status, "CANCELLED");
  });

  test("תצוגת לקוח: סכום חיוב חודשי, מופעים קרובים, היסטוריית חיובים, וללא נתוני משתמש אחר", async () => {
    await createOk(ids.a);
    await createOk(ids.b, { roomKey: "ROOM4" });
    const mine = await views.getMyShifts({ userId: ids.a, provider, now: NOW });
    assert.equal(mine.shifts.length, 1);
    assert.equal(mine.eligible, true);
    assert.equal(mine.hasUsableCard, true);
    const s = mine.shifts[0];
    assert.deepEqual([s.status, s.usable, s.occurrencePriceAgorot, s.counts.scheduled], ["ACTIVE", true, 16640, 11]);
    assert.deepEqual(s.months.map((m) => [m.month, m.count, m.amountAgorot, m.chargeStatus]), [["2027-02", 2, 33280, "PAID"], ["2027-03", 5, 83200, null], ["2027-04", 4, 66560, null]]);
    assert.deepEqual(s.nextCharge, { month: "2027-03", amountAgorot: 83200 });
    assert.equal(s.charges.length, 1);
    assert.ok(s.upcoming.length > 0 && s.upcoming.length <= 6);
    assert.ok(!JSON.stringify(mine).includes(ids.b));
    const noPerm = await views.getMyShifts({ userId: ids.noPerm, provider, now: NOW });
    assert.equal(noPerm.eligible, false);
    const admin = await views.listShiftsAdmin({ roomKey: "ROOM4" });
    assert.deepEqual(admin.map((r) => r.user.id), [ids.b]);
    assert.equal((await views.listShiftsAdmin({ status: "SUSPENDED" })).length, 0);
    assert.equal((await views.listEligibility(undefined)).length > 0, true);
  });
});
