import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RunningApp, Method } from "@/ivr/test-harness";

// בדיקות הזרימה האמיתית של ה-IVR (מסלולים 9, 9/1, 9/2) מול נתב ימות המשיח האמיתי, המטפלים האמיתיים ו-PostgreSQL
// מקומי ייעודי, בבקשות HTTP אמיתיות בשתי השיטות (GET ו-POST). רצות רק כש-IVR_TEST_DATABASE_URL מוגדר ומצביע על מסד
// מקומי בשם *_test. דוגמה:
//   IVR_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_ivr_test npm test
const testUrl = process.env.IVR_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) {
    throw new Error("IVR_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
  }
}

const SECRET = "http-test-secret-xyz";
const METHODS: Method[] = ["GET", "POST"];

const PHONES = {
  male: "0501110011",
  female: "0501110012",
  pending: "0501110013",
  blocked: "0501110014",
  male2: "0501110015",
  unknown: "0501110099",
  registering: "0501110088",
};
const MALE_NAME = "ג'ון כהן"; // גרש בשם: בודק שהשם לא נרשם בלוג
const PIN_REG = "7391";

describe("IVR אמיתי מול מסד: GET ו-POST", { skip: !testUrl && "IVR_TEST_DATABASE_URL לא מוגדר" }, () => {
  type Prisma = typeof import("@/lib/prisma").prisma;
  let prisma: Prisma;
  let app: RunningApp;
  let h: typeof import("@/ivr/test-harness");
  let booking: typeof import("@/lib/booking");
  let hoursDb: typeof import("@/lib/opening-hours-db");
  let verifyPassword: typeof import("@/lib/password").verifyPassword;
  let mondayLocal: Date;
  let saturdayLocal: Date;
  const ids: Record<string, string> = {};

  const path = (name: string) => `/${name}-${SECRET}`;
  let counter = 0;
  const newCallId = () => `http-${Date.now()}-${counter++}`;
  const baseParams = (callId: string, phone: string, ext: string): [string, string][] => [
    ["ApiPhone", phone],
    ["ApiDID", "035551234"],
    ["ApiExtension", ext],
    ["ApiCallId", callId],
  ];
  const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;

  /** מנהל שיחה כמו ימות המשיח: בקשה ראשונה ואז כל הקשה נוספת מצטברת. מחזיר את כל התשובות */
  async function drive(method: Method, route: string, ext: string, phone: string, answers: string[], callId = newCallId()) {
    const replies: string[] = [];
    const vals: [string, string][] = [];
    let r = await h.send(app.base, path(route), method, baseParams(callId, phone, ext));
    replies.push(r.text);
    for (const answer of answers) {
      const name = h.nextValName(r.text);
      if (!name) break;
      vals.push([name, answer]);
      r = await h.send(app.base, path(route), method, [...baseParams(callId, phone, ext), ...vals]);
      replies.push(r.text);
    }
    return replies;
  }

  const bookingAnswers = (date: Date, hhmm: string, room = "5") => [room, "4", ddmm(date), hhmm, "4", "1"];
  const ivrAppointments = () => prisma.appointment.findMany({ where: { source: "IVR" }, include: { room: true } });

  async function wipe() {
    await prisma.payment.deleteMany({});
    await prisma.appointment.deleteMany({});
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    h = await import("@/ivr/test-harness");
    ({ prisma } = await import("@/lib/prisma"));
    booking = await import("@/lib/booking");
    hoursDb = await import("@/lib/opening-hours-db");
    ({ verifyPassword } = await import("@/lib/password"));
    const { hashPassword } = await import("@/lib/password");
    const { createIvrApp } = await import("@/ivr/app");
    const flow = await import("@/ivr/booking-flow");
    app = await h.startApp(
      createIvrApp({
        secret: SECRET,
        handlers: { check: flow.handleCheckCall, members: flow.handleMembersCall, notRegistered: flow.handleNotRegisteredCall },
      })
    );

    // יום שני ושבת בעוד כחודשיים (לפי שעון מקומי, כמו שה-IVR בונה תאריכים)
    const d = new Date();
    d.setDate(d.getDate() + 60);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    mondayLocal = d;
    const s = new Date(d);
    s.setDate(s.getDate() + 5);
    saturdayLocal = s;

    await wipe();
    await prisma.user.deleteMany({ where: { phone: { in: Object.values(PHONES) } } });
    const passwordHash = await hashPassword("4321");
    const mk = async (key: keyof typeof PHONES, extra: Record<string, unknown>) => {
      const u = await prisma.user.create({ data: { name: `ivr ${key}`, phone: PHONES[key], passwordHash, ...extra } });
      ids[key] = u.id;
    };
    await mk("male", { name: MALE_NAME, gender: "MALE", status: "APPROVED" });
    await mk("female", { gender: "FEMALE", status: "APPROVED" });
    await mk("male2", { gender: "MALE", status: "APPROVED" });
    await mk("pending", { gender: "MALE", status: "PENDING" });
    await mk("blocked", { gender: "MALE", status: "BLOCKED" });
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { phone: { in: Object.values(PHONES) } } });
    await prisma.$disconnect();
    await app?.close();
  });

  test("שלוחת הבדיקה (9): ניתוב לפי סטטוס המתקשר, בשתי השיטות", async () => {
    for (const method of METHODS) {
      const go = async (phone: string) => (await h.send(app.base, path("check"), method, baseParams(newCallId(), phone, "9"))).text;
      assert.equal(await go(PHONES.male), "go_to_folder=/9/1", method);
      assert.equal(await go(PHONES.unknown), "go_to_folder=/9/2", method);
      for (const phone of [PHONES.pending, PHONES.blocked, "AnonymousPhone"]) {
        const text = await go(phone);
        assert.ok(!text.startsWith("go_to_folder"), `${method} ${phone}: ${text}`);
        assert.match(text, /^id_list_message=/);
      }
    }
  });

  test("שלוחה 9/1: קביעת תור מלאה (חדר, תאריך, שעה, משך, אישור) נוצרת בשתי השיטות, והברכה פעם אחת", async () => {
    for (const [i, method] of METHODS.entries()) {
      await wipe();
      const replies = await drive(method, "booking", "9/1", PHONES.male, bookingAnswers(mondayLocal, "1200"));
      assert.equal(replies.length, 7, `${method}: 6 קלטים ותשובה סופית`);
      assert.match(replies[0], /שלום/, "הברכה בבקשת הקלט הראשונה");
      for (const later of replies.slice(1)) assert.ok(!later.includes("שלום"), `${method}: הברכה לא חוזרת`);
      const rows = await ivrAppointments();
      assert.equal(rows.length, 1, method);
      assert.deepEqual([rows[0].room.key, rows[0].status, rows[0].userId, rows[0].paymentStatus], ["ROOM3", "CONFIRMED", ids.male, "NOT_REQUIRED"], `${method} #${i}`);
      assert.equal((rows[0].endTime.getTime() - rows[0].startTime.getTime()) / 60000, 60);
      assert.equal(rows[0].holdExpiresAt, null, "ה-IVR עדיין לא משתמש בהחזקה או בתשלום");
    }
  });

  test("9/1: מספר לא רשום מנותב ל-9/2, וממתין/חסום/חסוי מקבלים הודעה בשתי השיטות", async () => {
    await wipe();
    for (const method of METHODS) {
      const first = async (phone: string) => (await h.send(app.base, path("booking"), method, baseParams(newCallId(), phone, "9/1"))).text;
      assert.equal(await first(PHONES.unknown), "go_to_folder=/9/2", method);
      for (const phone of [PHONES.pending, PHONES.blocked, "AnonymousPhone"]) {
        assert.match(await first(phone), /^id_list_message=/, `${method} ${phone}`);
      }
    }
    assert.equal((await ivrAppointments()).length, 0);
  });

  test("9/2: תפריט לא-רשום (הרשמה/הסבר/ניתוק) בשתי השיטות; רשום מנותב ל-9/1", async () => {
    for (const method of METHODS) {
      const call = (phone: string, answers: string[]) => drive(method, "not-registered", "9/2", phone, answers);
      assert.equal((await call(PHONES.unknown, ["2"])).at(-1), "go_to_folder=/9/3", method);
      assert.equal((await call(PHONES.unknown, ["3"])).at(-1), "go_to_folder=hangup", method);
      assert.equal((await call(PHONES.male, [])).at(-1), "go_to_folder=/9/1", method);
    }
  });

  test("הרשמה בטלפון: הקוד מגיע בגוף POST ונשמר ב-ivrPinHash (לא ב-passwordHash), והמשתמש ממתין לאישור (וגם ב-GET)", async () => {
    for (const method of METHODS) {
      const phone = method === "POST" ? PHONES.registering : "0501110087";
      await prisma.user.deleteMany({ where: { phone } });
      const replies = await drive(method, "not-registered", "9/2", phone, ["1", "דני לוי", PIN_REG, PIN_REG]);
      assert.equal(replies.length, 5, method);
      const user = await prisma.user.findFirstOrThrow({ where: { phone } });
      assert.equal(user.status, "PENDING");
      // הקוד הטלפוני נשמר רק ב-ivrPinHash (bcrypt); passwordHash מקבל hash אקראי, והקוד אינו סיסמת אתר
      assert.ok(user.ivrPinHash && user.ivrPinHash !== PIN_REG, "הקוד נשמר כ-hash");
      assert.ok(await verifyPassword(PIN_REG, user.ivrPinHash!), "ivrPinHash מאמת את הקלט");
      assert.equal(await verifyPassword(PIN_REG, user.passwordHash), false, "הקוד אינו סיסמת האתר");
      assert.equal(user.email, null, "אין אימייל, ולכן אין התחברות לאתר");
      const { verifyIvrPin } = await import("@/lib/ivr-pin/service");
      assert.deepEqual(await verifyIvrPin({ userId: user.id, pin: PIN_REG }), { status: "OK" });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("שבת נחסמת (גם בטלפון) ושעות מחוץ לפעילות נדחות, בשתי השיטות, בלי ליצור תור", async () => {
    await wipe();
    for (const method of METHODS) {
      const sat = await drive(method, "booking", "9/1", PHONES.male, bookingAnswers(saturdayLocal, "1200"));
      assert.match(sat.at(-1)!, /אינו זמין/, `${method} שבת`);
      const night = await drive(method, "booking", "9/1", PHONES.male, bookingAnswers(mondayLocal, "0300"));
      assert.match(night.at(-1)!, /אינו זמין/, `${method} לילה`);
    }
    assert.equal((await ivrAppointments()).length, 0);
  });

  test("מסלולי בנים/בנות ושעות הפעילות נאכפים בדיוק כמו בהזמנה רגילה (תוצאת ה-IVR זהה לבדיקת השרת)", async () => {
    for (const [key, hhmm] of [["female", "1200"], ["male", "1200"], ["female", "0900"]] as const) {
      await wipe();
      const start = new Date(mondayLocal.getFullYear(), mondayLocal.getMonth(), mondayLocal.getDate(), Number(hhmm.slice(0, 2)), 0);
      const end = new Date(start.getTime() + 3600_000);
      let allowed = true;
      try {
        await hoursDb.assertBookable(start, end, "IVR", ids[key]);
      } catch (err) {
        assert.ok(err instanceof booking.BookingError);
        allowed = false;
      }
      for (const method of METHODS) {
        await wipe();
        await drive(method, "booking", "9/1", PHONES[key], bookingAnswers(mondayLocal, hhmm));
        assert.equal((await ivrAppointments()).length, allowed ? 1 : 0, `${key} ${hhmm} ${method}`);
      }
    }
  });

  test("מניעת הזמנה כפולה: שתי שיחות מקבילות (GET ו-POST) לאותו חדר ושעה, רק אחת נקבעת", async () => {
    for (let round = 0; round < 4; round++) {
      await wipe();
      const room = "5";
      const [a, b] = await Promise.all([
        drive("GET", "booking", "9/1", PHONES.male, bookingAnswers(mondayLocal, "1300", room)),
        drive("POST", "booking", "9/1", PHONES.male2, bookingAnswers(mondayLocal, "1300", room)),
      ]);
      const rows = await ivrAppointments();
      assert.equal(rows.length, 1, `סבב ${round}`);
      const losers = [a, b].filter((replies) => /תפוס/.test(replies.at(-1)!));
      assert.equal(losers.length, 1, `סבב ${round}: אחד מקבל הודעת תפוס`);
    }
  });

  test("ניתוק באמצע חיוג, וקלט לא תקין: אין תור ואין קריסה, בשתי השיטות", async () => {
    await wipe();
    for (const method of METHODS) {
      const callId = newCallId();
      const phone = PHONES.male;
      await h.send(app.base, path("booking"), method, baseParams(callId, phone, "9/1"));
      const hang = await h.send(app.base, path("booking"), method, [...baseParams(callId, phone, "9/1"), ["hangup", "yes"]]);
      assert.equal(hang.status, 200);
      // תאריך לא תקין (31/02) פעמיים ואז המשך תקין: השיחה לא נשברת
      const replies = await drive(method, "booking", "9/1", phone, ["5", "4", "3102", "3102", "3102"]);
      assert.ok(replies.length >= 4);
    }
    assert.equal((await ivrAppointments()).length, 0);
  });

  test("הכניסה החוזרת באמצע שיחה (כמו כוכבית) זהה בשתי השיטות ואינה יוצרת תור", async () => {
    const out: Record<string, string[]> = {};
    for (const method of METHODS) {
      const callId = newCallId();
      const first = await h.send(app.base, path("booking"), method, baseParams(callId, PHONES.male, "9/1"));
      const again = await h.send(app.base, path("booking"), method, baseParams(callId, PHONES.male, "9/1"));
      assert.match(again.text, /^read=/);
      out[method] = [first.text.replace(/val_\d+/g, "VAL"), again.text.replace(/val_\d+/g, "VAL")];
    }
    assert.deepEqual(out.POST, out.GET);
    assert.equal((await ivrAppointments()).length, 0);
  });

  test("אין בלוגים טלפון, קוד או שם לקוח (כולל שם עם גרש), בשתי השיטות", async () => {
    await wipe();
    const { output } = await h.captureConsole(async () => {
      for (const method of METHODS) {
        await wipe();
        await drive(method, "booking", "9/1", PHONES.male, bookingAnswers(mondayLocal, "1200"));
        await drive(method, "not-registered", "9/2", PHONES.registering, ["1", "דני לוי", PIN_REG, PIN_REG]);
        await prisma.user.deleteMany({ where: { phone: PHONES.registering } });
        await h.send(app.base, path("check"), method, baseParams(newCallId(), "AnonymousPhone", "9"));
      }
    });
    assert.ok(output.includes("[ivr] new call"), "לוג תפעולי קיים");
    for (const sensitive of [PHONES.male.slice(1), PHONES.registering.slice(1), PIN_REG, MALE_NAME, "ג'ון", SECRET, "דני לוי"]) {
      assert.ok(!output.includes(sensitive), `הלוג כולל "${sensitive}":\n${output}`);
    }
  });

  test("רגרסיה: ה-IVR אינו יוצר החזקות, תשלומים או חובות (זרימת התשלום עדיין לא מחוברת)", async () => {
    await wipe();
    await drive("POST", "booking", "9/1", PHONES.male, bookingAnswers(mondayLocal, "1500"));
    assert.equal(await prisma.payment.count({}), 0);
    assert.equal(await prisma.debt.count({}), 0);
    assert.equal(await prisma.appointment.count({ where: { status: "PENDING_PAYMENT" } }), 0);
    assert.equal(await prisma.appointment.count({ where: { source: "IVR", status: "CONFIRMED" } }), 1);
  });
});
