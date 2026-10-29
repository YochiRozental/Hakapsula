/**
 * נתוני הדגמה לסביבת ההדגמה המקומית בלבד (מסד clinics_demo). נקרא מ-scripts/demo/start.mjs; אפשר גם ידנית:
 *   DATABASE_URL=postgresql://.../clinics_demo PAYMENT_WEBHOOK_SECRET=... DEMO_PASSWORDS_FILE=.demo/credentials.json npx tsx scripts/demo/seed.ts
 * בטיחות: מסרב לרוץ מול כל מסד שאינו localhost/clinics_demo. כל הכספים הם Mock; אין חיוב אמיתי. אין כאן סיסמאות קבועות:
 * הן נוצרות אקראית ונכתבות לקובץ מקומי שאינו נכנס ל-Git.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
const parsed = new URL(url);
if (parsed.hostname !== "localhost" || parsed.pathname !== "/clinics_demo") {
  console.error("מסרב: ההדגמה רצה רק מול localhost/clinics_demo");
  process.exit(2);
}

const MARK = "הדגמה – ";
const CARD_EXPIRY = "12/30";

/** מחשב ספרת ביקורת לתעודת זהות ישראלית (9 ספרות) מגוף של 8 ספרות */
function idWithCheckDigit(body8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let n = Number(body8[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return body8 + String((10 - (sum % 10)) % 10);
}

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { ensureRooms } = await import("../../src/lib/rooms-db");
  const { MockPaymentProvider } = await import("../../src/lib/payments/mock-provider");
  const { PrismaMockStore } = await import("../../src/lib/payments/mock-store");
  const pay = await import("../../src/lib/payments/booking-payment");
  const pkgs = await import("../../src/lib/payments/packages");
  const cards = await import("../../src/lib/payments/saved-methods");
  const shifts = await import("../../src/lib/shifts/schedule");
  const shiftBilling = await import("../../src/lib/shifts/billing");
  const debtBooking = await import("../../src/lib/finance/debt-booking");
  const { jerusalemWallInstant, jerusalemTodayIso } = await import("../../src/lib/jerusalem-time");

  if ((await prisma.user.count({ where: { email: { endsWith: "@demo.local" } } })) > 0) {
    console.log("נתוני ההדגמה כבר קיימים (להתחלה מחדש: npm run demo:reset)");
    await prisma.$disconnect();
    return;
  }

  const provider = new MockPaymentProvider(process.env.PAYMENT_WEBHOOK_SECRET ?? "demo-secret-demo-secret-demo-secret", new PrismaMockStore(prisma));
  await ensureRooms();

  // ───────── משתמשים ─────────
  const passwords: Record<string, string> = {};
  const pw = () => randomBytes(9).toString("base64url");
  let seq = 0;
  async function mk(key: string, title: string, extra: Record<string, unknown> = {}) {
    const password = pw();
    passwords[key] = password;
    seq++;
    const first = `${MARK.trim()}`;
    return prisma.user.create({
      data: {
        name: `${MARK}${title}`,
        firstName: first,
        lastName: title.split(" ")[0],
        email: `${key}@demo.local`,
        phone: `05010000${String(seq).padStart(2, "0")}`,
        idNumber: idWithCheckDigit(String(30000000 + seq * 17).padStart(8, "0")),
        gender: "MALE",
        cardLast4: "4242",
        cardExpiry: CARD_EXPIRY,
        passwordHash: await bcrypt.hash(password, 10),
        status: "APPROVED",
        ...extra,
      } as never,
    });
  }
  const admin = await mk("admin", "מנהל", { role: "ADMIN", firstName: "מנהל", lastName: "הדגמה", cardLast4: null, cardExpiry: null });
  const dan = await mk("dan", "דן (חבילה פעילה)");
  const yossi = await mk("yossi", "יוסי (יתרה חלקית)");
  const avi = await mk("avi", "אבי (הזמנה ששולמה)");
  const moshe = await mk("moshe", "משה (הזמנה עם חוב)");
  const levi = await mk("levi", "לוי (בקשת ביטול חבילה)");
  const cohen = await mk("cohen", "כהן (החזר ממתין)");
  const shimon = await mk("shimon", "שמעון (משמרת פעילה)", { canBookShifts: true });
  const binyamin = await mk("binyamin", "בנימין (משמרת - חיוב נכשל)", { canBookShifts: true });
  const gad = await mk("gad", "גד (משמרת מושעית)", { canBookShifts: true });
  const reuven = await mk("reuven", "ראובן (תשלום בבירור)");
  const tester = await mk("tester", "לקוח לניסוי עצמי", { canBookShifts: true });

  // ───────── עזרים ─────────
  const addCard = async (userId: string, key: string) => {
    const r = await cards.addMockCard({ userId, currentPassword: passwords[key], provider });
    if (r.status !== "OK") throw new Error("addMockCard " + r.status);
  };
  const keyOf = () => `demo${randomBytes(8).toString("hex")}`;
  /** היום הבא (מחר ואילך) בשבוע נתון, 0=ראשון. ברירות המחדל: שני/רביעי/שישי = בנים */
  const nextDow = (dow: number, minAhead = 1) => {
    const d = new Date(`${jerusalemTodayIso()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + minAhead);
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const at = (iso: string, hour: number) => {
    const start = jerusalemWallInstant(iso, hour * 60);
    return { startTime: start, endTime: new Date(start.getTime() + 3600_000) };
  };
  async function buyPackage(userId: string, hours: number) {
    const started = await pkgs.startPackagePurchase({ userId, hours, clientKey: keyOf(), provider });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    await pkgs.finalizePackagePayment({ paymentId: started.paymentId, provider });
    return prisma.hoursPackage.findUniqueOrThrow({ where: { paymentId: started.paymentId } });
  }
  async function paidBooking(userId: string, roomKey: "ROOM1" | "ROOM2" | "ROOM3" | "ROOM4", slot: { startTime: Date; endTime: Date }, source: "WEB" | "ADMIN" = "WEB") {
    const hold = await pay.holdRoom({ userId, roomKey, ...slot, source });
    const started = await pay.startBookingPayment({ appointmentId: hold.id, userId, provider, useBalance: false });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    const fin = await pay.finalizeBookingPayment({ paymentId: started.paymentId, provider });
    if (fin.outcome !== "CONFIRMED") throw new Error("paid booking " + fin.outcome);
    return { appointmentId: hold.id, paymentId: started.paymentId };
  }

  // 1. לקוח עם חבילת שעות פעילה + כרטיס
  await buyPackage(dan.id, 10);
  await addCard(dan.id, "dan");

  // 2. יתרה חלקית: חבילה של 5 שעות, שעתיים נוצלו בהזמנות מהיתרה
  await buyPackage(yossi.id, 5);
  await addCard(yossi.id, "yossi");
  for (const [i, day] of [nextDow(3, 2), nextDow(3, 9)].entries()) {
    const hold = await pay.holdRoom({ userId: yossi.id, roomKey: "ROOM2", ...at(day, 9 + i), source: "WEB" });
    await pay.confirmBookingFromBalance({ appointmentId: hold.id, userId: yossi.id, provider });
  }

  // 3-4. הזמנה ששולמה בכסף + כרטיס שמור
  await addCard(avi.id, "avi");
  await paidBooking(avi.id, "ROOM2", at(nextDow(5, 2), 10));

  // 5. הזמנה עם חוב (אישור מנהל, בנתיב הניהול הכספי)
  await debtBooking.approveBookingWithDebt({ adminId: admin.id, userId: moshe.id, roomKey: "ROOM4", date: nextDow(1, 3), start: "13:00", durationMinutes: 60, reason: "הזמנת הדגמה ללא תשלום מראש", confirm: true, expectedDebtAgorot: 5200 });

  // 6. בקשת ביטול חבילה ממתינה
  const leviPkg = await buyPackage(levi.id, 5);
  await pkgs.requestPackageCancellation({ userId: levi.id, packageId: leviPkg.id, reason: "שיניתי תוכניות" });

  // 7. בקשת החזר שממתינה לאישור: הזמנה ששולמה ובוטלה פחות מ-24 שעות לפני ההתחלה (חריג החזר להכרעה)
  let lateNote = "";
  {
    const start = new Date(Date.now() + 3 * 3600_000);
    start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 15) * 15, 0, 0);
    const slot = { startTime: start, endTime: new Date(start.getTime() + 3600_000) };
    try {
      const b = await paidBooking(cohen.id, "ROOM1", slot, "ADMIN");
      const res = await pay.cancelBooking({ appointmentId: b.appointmentId, requester: { id: cohen.id, role: "CLIENT" }, provider });
      lateNote = res.outcome;
    } catch (e) {
      lateNote = "לא נוצר: " + (e instanceof Error ? e.message : "שגיאה");
    }
  }

  // 8. משמרת קבועה פעילה
  await addCard(shimon.id, "shimon");
  const s1 = await shifts.createShift({ userId: shimon.id, roomKey: "ROOM3", weekday: 1, windowId: "MORNING", startDate: nextDow(1, 1), clientKey: keyOf(), provider });
  // 9-10. משמרות עם חיוב שנכשל (בתקופת חסד) ומושעית
  await addCard(binyamin.id, "binyamin");
  await addCard(gad.id, "gad");
  const s2 = await shifts.createShift({ userId: binyamin.id, roomKey: "ROOM4", weekday: 3, windowId: "AFTERNOON", startDate: nextDow(3, 1), clientKey: keyOf(), provider });
  const s3 = await shifts.createShift({ userId: gad.id, roomKey: "ROOM1", weekday: 1, windowId: "NOON", startDate: nextDow(1, 1), clientKey: keyOf(), provider });
  for (const s of [s1, s2, s3]) if (s.status !== "ACTIVE") throw new Error("shift creation: " + s.status);
  // החיוב הראשון של שתי המשמרות האחרונות סומן ככושל (נתוני הדגמה): הכרטיס נדחה; גד כבר עבר את שבעת ימי החסד
  const DAY = 86400_000;
  async function failFirstCharge(shiftId: string, userId: string, graceUntil: Date, firstFailure: Date) {
    const charge = await prisma.shiftCharge.findFirstOrThrow({ where: { shiftId, isFirst: true } });
    if (charge.paymentId) await prisma.payment.update({ where: { id: charge.paymentId }, data: { status: "FAILED", failureCode: "card_declined", paidAt: null } });
    await prisma.shiftCharge.update({ where: { id: charge.id }, data: { status: "FAILED", failureCode: "card_declined", paidAt: null, graceUntil, lastAttemptAt: firstFailure } });
    const card = await prisma.paymentMethod.findFirstOrThrow({ where: { userId, active: true } });
    await provider.declineToken(card.token);
  }
  await failFirstCharge(s2.shiftId, binyamin.id, new Date(Date.now() + 4 * DAY), new Date(Date.now() - 3 * DAY));
  await failFirstCharge(s3.shiftId, gad.id, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 9 * DAY));
  await shiftBilling.runMonthlyShiftBilling({ provider, trigger: "demo-seed", now: new Date() });
  const gadShift = await prisma.shift.findUniqueOrThrow({ where: { id: s3.shiftId } });
  if (gadShift.status !== "SUSPENDED") {
    // רשת ביטחון להדגמה בלבד: אם הריצה לא השעתה (תלוי בלוח הזמנים), מסמנים השעיה בגלל כשל חיוב
    await prisma.shift.update({ where: { id: s3.shiftId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: `payment_failed:${gadShift.startDate.slice(0, 7)}` } });
  }

  // 11. תשלומים במצב בירור: (א) הספק גבה אך האתר לא עודכן; (ב) תשלום שנקטע לפני שנשמר מזהה הספק
  {
    const hold = await pay.holdRoom({ userId: reuven.id, roomKey: "ROOM2", ...at(nextDow(5, 9), 11), source: "WEB" });
    const started = await pay.startBookingPayment({ appointmentId: hold.id, userId: reuven.id, provider, useBalance: false });
    await provider.completeCheckout(started.providerPaymentId!, "success");
    // ההדגמה מאריכה את ההחזקה כדי שאימות מול הספק יאשר את ההזמנה (ולא יחזיר כסף כתשלום מאוחר)
    await prisma.appointment.update({ where: { id: hold.id }, data: { holdExpiresAt: new Date(Date.now() + 30 * DAY) } });
    await prisma.payment.update({ where: { id: started.paymentId }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });

    const hold2 = await pay.holdRoom({ userId: reuven.id, roomKey: "ROOM1", ...at(nextDow(5, 9), 14), source: "WEB" });
    await prisma.appointment.update({ where: { id: hold2.id }, data: { holdExpiresAt: new Date(Date.now() + 30 * DAY) } });
    await prisma.payment.create({
      data: {
        userId: reuven.id,
        appointmentId: hold2.id,
        purpose: "BOOKING",
        amountAgorot: 5200,
        status: "PENDING",
        environment: "SANDBOX",
        provider: "mock",
        idempotencyKey: `booking:${hold2.id}:1`,
        createdAt: new Date(Date.now() - 2 * 3600_000),
      },
    });
  }

  // לקוח לניסוי עצמי: כרטיס שמור, ללא חבילות/משמרות, ללא קוד IVR
  await addCard(tester.id, "tester");

  const out = process.env.DEMO_PASSWORDS_FILE;
  const accounts = [
    { key: "admin", label: "מנהל", name: admin.name },
    { key: "dan", label: "חבילת שעות פעילה (10 שעות) + כרטיס", name: dan.name },
    { key: "yossi", label: "יתרה חלקית (3 מתוך 5 שעות) + כרטיס", name: yossi.name },
    { key: "avi", label: "הזמנה ששולמה + כרטיס", name: avi.name },
    { key: "moshe", label: "הזמנה עם חוב פתוח", name: moshe.name },
    { key: "levi", label: "בקשת ביטול חבילה ממתינה", name: levi.name },
    { key: "cohen", label: `החזר ממתין להכרעה (${lateNote})`, name: cohen.name },
    { key: "shimon", label: "משמרת קבועה פעילה", name: shimon.name },
    { key: "binyamin", label: "משמרת עם חיוב שנכשל (תקופת חסד)", name: binyamin.name },
    { key: "gad", label: "משמרת מושעית", name: gad.name },
    { key: "reuven", label: "שני תשלומים בבירור", name: reuven.name },
    { key: "tester", label: "לקוח נקי לניסוי עצמי (כרטיס שמור, זכאי למשמרות)", name: tester.name },
  ].map((a) => ({ ...a, email: `${a.key}@demo.local`, password: passwords[a.key] }));
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(accounts, null, 2));
  }
  console.log(`נתוני הדגמה נוצרו (${accounts.length} חשבונות). חריג ההחזר: ${lateNote}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("seed failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
