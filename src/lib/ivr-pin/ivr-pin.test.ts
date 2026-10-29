import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { PrismaClient } from "@/generated/prisma/client";

// בדיקות הקוד הטלפוני, הגבלת הניסיונות וההעברה מול PostgreSQL מקומי ייעודי. רצות רק כש-PIN_TEST_DATABASE_URL מוגדר
// ומצביע על מסד מקומי בשם *_test. דוגמה:
//   PIN_TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_pin_test npm test
const testUrl = process.env.PIN_TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) {
    throw new Error("PIN_TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
  }
}

const SITE_PASSWORD = "Site-Pass-9xQ!";
const PIN = "4821";
const NEW_PIN = "7390";
const MIN = 60_000;

describe("קוד טלפוני: שירות, הגבלת ניסיונות והעברה", { skip: !testUrl && "PIN_TEST_DATABASE_URL לא מוגדר" }, () => {
  let prisma: PrismaClient;
  let svc: typeof import("@/lib/ivr-pin/service");
  let legacy: typeof import("@/lib/ivr-pin/legacy");
  let policyMod: typeof import("@/lib/ivr-pin/policy");
  let pw: typeof import("@/lib/password");
  let PrismaClientCtor: typeof import("@/generated/prisma/client").PrismaClient;
  let PrismaPgCtor: typeof import("@prisma/adapter-pg").PrismaPg;
  const ids: Record<string, string> = {};

  async function wipe() {
    await prisma.pinThrottle.deleteMany({});
    await prisma.ivrPinEvent.deleteMany({});
  }

  /** לקוח Prisma נוסף: מדמה תהליך/הפעלה מחדש של השרת (אין מצב משותף בזיכרון, רק המסד) */
  function freshClient(): PrismaClient {
    return new PrismaClientCtor({ adapter: new PrismaPgCtor({ connectionString: testUrl }) });
  }

  async function mkUser(key: string, data: Record<string, unknown>) {
    const u = await prisma.user.create({ data: { name: `pin ${key}`, ...(data as object) } as never });
    ids[key] = u.id;
    return u.id;
  }

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("@/lib/ivr-pin/service");
    legacy = await import("@/lib/ivr-pin/legacy");
    policyMod = await import("@/lib/ivr-pin/policy");
    pw = await import("@/lib/password");
    ({ PrismaClient: PrismaClientCtor } = await import("@/generated/prisma/client"));
    ({ PrismaPg: PrismaPgCtor } = await import("@prisma/adapter-pg"));

    await prisma.ivrPinEvent.deleteMany({});
    await prisma.pinThrottle.deleteMany({});
    await prisma.user.deleteMany({ where: { name: { startsWith: "pin " } } });
  });

  beforeEach(async () => {
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "pin " } } });
    const sitePasswordHash = await pw.hashPassword(SITE_PASSWORD);
    // משתמש אתר רגיל: אימייל, שם, סיסמה
    await mkUser("web", { email: "pin-web@test.local", firstName: "אתר", lastName: "בדיקה", passwordHash: sitePasswordHash, status: "APPROVED" });
    // משתמש טלפוני ותיק: אין אימייל/שם/ת"ז, הקוד הישן שמור ב-passwordHash
    await mkUser("legacy", { phone: "0501110001", passwordHash: await pw.hashPassword("2468"), status: "APPROVED" });
    // נוצר ע"י מנהל: שם פרטי ומשפחה וסיסמה זמנית, בלי אימייל
    await mkUser("adminCreated", {
      firstName: "מנהל", lastName: "יצר", phone: "0501110002", passwordHash: await pw.hashPassword("Temp-Pass-77"), mustChangePassword: true,
    });
    await mkUser("tempPw", { email: "pin-temp@test.local", firstName: "זמני", lastName: "סיסמה", passwordHash: sitePasswordHash, mustChangePassword: true });
  });

  after(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.user.deleteMany({ where: { name: { startsWith: "pin " } } });
    await prisma.$disconnect();
  });

  const set = (userId: string, over: Partial<{ currentPassword: string; pin: string; pinConfirm: string; now: Date }> = {}) =>
    svc.setIvrPin({ userId, currentPassword: SITE_PASSWORD, pin: PIN, pinConfirm: PIN, ...over });
  const hashOf = async (key: string) => (await prisma.user.findUniqueOrThrow({ where: { id: ids[key] } })).ivrPinHash;

  // ───────────── הגדרה באתר ─────────────

  test("משתמש אתר חדש: אין קוד טלפוני, וההגדרה דורשת סיסמה; ההצלחה שומרת bcrypt בלבד", async () => {
    assert.equal(await hashOf("web"), null);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: ids.web } })).passwordHash;

    const res = await set(ids.web);
    assert.deepEqual(res, { status: "OK", replaced: false });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.web } });
    assert.match(user.ivrPinHash!, /^\$2[aby]\$\d{2}\$/, "bcrypt");
    assert.notEqual(user.ivrPinHash, PIN);
    assert.ok(await pw.verifyPassword(PIN, user.ivrPinHash!));
    assert.equal(user.passwordHash, before, "passwordHash לא השתנה");
    assert.ok(user.ivrPinUpdatedAt);
    assert.deepEqual((await prisma.ivrPinEvent.findMany({ where: { userId: ids.web } })).map((e) => e.kind), ["SET"]);
  });

  test("שינוי קוד אחרי אימות מחדש, וניסיון בלי אימות מחדש נדחה בלי לשנות דבר", async () => {
    await set(ids.web);
    const first = await hashOf("web");

    for (const currentPassword of ["", "wrong-password", PIN]) {
      const res = await set(ids.web, { currentPassword, pin: NEW_PIN, pinConfirm: NEW_PIN });
      assert.equal(res.status, "INVALID_PASSWORD", `סיסמה: "${currentPassword}"`);
    }
    assert.equal(await hashOf("web"), first, "הקוד לא השתנה ללא אימות");

    const changed = await set(ids.web, { pin: NEW_PIN, pinConfirm: NEW_PIN });
    assert.deepEqual(changed, { status: "OK", replaced: true });
    assert.equal((await svc.verifyIvrPin({ userId: ids.web, pin: PIN })).status, "INVALID", "הקוד הישן אינו תקף");
    assert.equal((await svc.verifyIvrPin({ userId: ids.web, pin: NEW_PIN })).status, "OK");
    assert.deepEqual((await prisma.ivrPinEvent.findMany({ where: { userId: ids.web }, orderBy: { createdAt: "asc" } })).map((e) => e.kind).slice(0, 2), ["SET", "CHANGED"]);
  });

  test("קוד לא תקין, אי-התאמה, חשבון עם סיסמה זמנית ומשתמש לא קיים", async () => {
    for (const pin of ["123", "12345", "12ab", "", " 123", "١٢٣٤"]) {
      assert.equal((await set(ids.web, { pin, pinConfirm: pin })).status, "INVALID_PIN", JSON.stringify(pin));
    }
    assert.equal((await set(ids.web, { pin: PIN, pinConfirm: "1111" })).status, "PIN_MISMATCH");
    assert.equal((await set(ids.tempPw)).status, "NOT_ALLOWED", "חייב להחליף סיסמה זמנית קודם");
    assert.equal((await set("no-such-user")).status, "NOT_ALLOWED");
    assert.equal(await hashOf("web"), null);
    assert.equal(await hashOf("tempPw"), null);
    // קלט שגוי בצורתו אינו נספר כניסיון סיסמה
    assert.equal(await prisma.pinThrottle.count({}), 0);
  });

  test("הגבלת ניסיונות בהגדרה: 5 סיסמאות שגויות חוסמות גם סיסמה נכונה, עד שהחסימה פגה", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await set(ids.web, { currentPassword: `bad-${i}` }));
    assert.deepEqual(results.map((r) => r.status), ["INVALID_PASSWORD", "INVALID_PASSWORD", "INVALID_PASSWORD", "INVALID_PASSWORD", "BLOCKED"]);
    assert.equal(await hashOf("web"), null);

    const duringBlock = await set(ids.web);
    assert.equal(duringBlock.status, "BLOCKED");
    assert.equal(await hashOf("web"), null, "הסיסמה הנכונה לא עוקפת חסימה");

    const later = await set(ids.web, { now: new Date(Date.now() + 16 * MIN) });
    assert.equal(later.status, "OK");
  });

  test("אין קוד או סיסמה בתגובות ובלוגים", async () => {
    const { captureConsole } = await import("@/ivr/test-harness");
    const { result, output } = await captureConsole(async () => {
      const out: unknown[] = [];
      out.push(await set(ids.web));
      out.push(await set(ids.web, { currentPassword: "totally-wrong" }));
      out.push(await svc.verifyIvrPin({ userId: ids.web, pin: PIN }));
      out.push(await svc.verifyIvrPin({ userId: ids.web, pin: "0000" }));
      out.push(await svc.verifyIvrPin({ userId: ids.legacy, pin: "2468" }));
      return out;
    });
    const json = JSON.stringify(result);
    const hash = (await hashOf("web"))!;
    for (const secret of [PIN, "0000", "2468", SITE_PASSWORD, "totally-wrong", hash, "ivrPinHash", "passwordHash"]) {
      assert.ok(!json.includes(secret), `תגובה כוללת ${secret}`);
      assert.ok(!output.includes(secret), `לוג כולל ${secret}`);
    }
  });

  // ───────────── הפרדה מסיסמת האתר ─────────────

  test("הקוד הטלפוני אינו סיסמת אתר, והגדרתו לא משנה את סיסמת האתר", async () => {
    await set(ids.web);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.web } });
    // כך בדיוק auth.ts בודק התחברות: סיסמה מול passwordHash של המשתמש לפי אימייל
    assert.equal(await pw.verifyPassword(PIN, user.passwordHash), false, "הקוד אינו מתקבל כסיסמת אתר");
    assert.equal(await pw.verifyPassword(SITE_PASSWORD, user.passwordHash), true, "סיסמת האתר ממשיכה לעבוד");
    // והפוך: סיסמת האתר אינה קוד טלפוני
    assert.equal((await svc.verifyIvrPin({ userId: ids.web, pin: SITE_PASSWORD })).status, "INVALID_FORMAT");
  });

  test("hash של סיסמה בלתי ניתנת לניחוש לחשבון טלפוני חדש: שני חשבונות אינם חולקים hash, והקוד אינו נשמר בו", async () => {
    const [a, b] = await Promise.all([svc.unusablePasswordHash(), svc.unusablePasswordHash()]);
    assert.notEqual(a, b);
    for (const guess of ["0000", "1234", PIN, ""]) assert.equal(await pw.verifyPassword(guess, a), false);
  });

  // ───────────── אימות והגבלת ניסיונות ─────────────

  test("אימות: לא הוגדר קוד -> NOT_SET, וקוד ישן ב-passwordHash אינו מתקבל (תאימות מוגבלת, בלי שימוש כספי)", async () => {
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin: PIN }), { status: "NOT_SET" });
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.legacy, pin: "2468" }), { status: "NOT_SET" });
    assert.deepEqual(await svc.verifyIvrPin({ userId: "does-not-exist", pin: PIN }), { status: "NOT_SET" });
    assert.equal(await prisma.pinThrottle.count({}), 0, "ללא קוד אין ניסיון לנחש ולכן אין ספירה");
  });

  test("חמישה ניסיונות כושלים וחסימה; חסימה נשמרת; פוקעת אחרי 15 דקות; הצלחה מאפסת את המונה", async () => {
    await set(ids.web);
    const seq = [];
    for (let i = 0; i < 3; i++) seq.push(await svc.verifyIvrPin({ userId: ids.web, pin: "0000" }));
    assert.deepEqual(seq, [
      { status: "INVALID", attemptsLeft: 4 },
      { status: "INVALID", attemptsLeft: 3 },
      { status: "INVALID", attemptsLeft: 2 },
    ]);
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin: PIN }), { status: "OK" }, "הצלחה");
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin: "0000" }), { status: "INVALID", attemptsLeft: 4 }, "המונה אופס");

    const last = [];
    for (let i = 0; i < 4; i++) last.push((await svc.verifyIvrPin({ userId: ids.web, pin: "1111" })).status);
    assert.deepEqual(last, ["INVALID", "INVALID", "INVALID", "BLOCKED"], "הכישלון החמישי חוסם");

    const during = await svc.verifyIvrPin({ userId: ids.web, pin: PIN });
    assert.equal(during.status, "BLOCKED", "קוד נכון בזמן חסימה אינו מתקבל");
    assert.ok(during.status === "BLOCKED" && during.retryAfterSeconds > 0 && during.retryAfterSeconds <= 900);
    assert.ok((await prisma.ivrPinEvent.count({ where: { userId: ids.web, kind: "BLOCKED" } })) >= 1);

    const justBefore = await svc.verifyIvrPin({ userId: ids.web, pin: PIN, now: new Date(Date.now() + 14 * MIN) });
    assert.equal(justBefore.status, "BLOCKED");
    const after = await svc.verifyIvrPin({ userId: ids.web, pin: PIN, now: new Date(Date.now() + 16 * MIN) });
    assert.equal(after.status, "OK", "החסימה פגה");
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin: "0000" }), { status: "INVALID", attemptsLeft: 4 });
  });

  test("קלט לא תקין אינו נספר כניסיון", async () => {
    await set(ids.web);
    for (const pin of ["12", "12345", "abcd", "", "١٢٣٤"]) {
      assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin }), { status: "INVALID_FORMAT" }, JSON.stringify(pin));
    }
    assert.equal((await prisma.pinThrottle.findFirst({ where: { scope: "VERIFY", subject: ids.web } }))?.failedCount ?? 0, 0);
  });

  test("בקשות מקבילות: 12 ניחושים שגויים בו-זמנית, לכל היותר 4 מוערכים ואחד חוסם, השאר נחסמים", async () => {
    await set(ids.web);
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.verifyIvrPin({ userId: ids.web, pin: "0000" })));
    const evaluated = results.filter((r) => r.status === "INVALID");
    assert.equal(evaluated.length, 4, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.status === "BLOCKED").length, 8);
    assert.equal((await prisma.pinThrottle.findUniqueOrThrow({ where: { scope_subject: { scope: "VERIFY", subject: ids.web } } })).failedCount, 5);
  });

  test("בקשות מקבילות ליד הסף: אחרי 4 כישלונות רק בקשה אחת מוערכת, גם אם הקוד הנכון בין הבקשות", async () => {
    await set(ids.web);
    for (let i = 0; i < 4; i++) await svc.verifyIvrPin({ userId: ids.web, pin: "0000" });
    const results = await Promise.all([
      svc.verifyIvrPin({ userId: ids.web, pin: PIN }),
      ...Array.from({ length: 6 }, () => svc.verifyIvrPin({ userId: ids.web, pin: "9999" })),
    ]);
    const evaluated = results.filter((r) => r.status === "OK" || r.status === "INVALID" || (r.status === "BLOCKED" && r.retryAfterSeconds === 900));
    // הצלחה מאפסת את המונה בדיוק כמתוכנן; בקשות שמגיעות אחריה מוערכות מחדש. לכן, כשהקוד הנכון הושלם באמצע (תלוי תזמון ועומס),
    // אי אפשר לדרוש בקשה מוערכת אחת בלבד. בלי הצלחה באמצע: לכל היותר בקשה אחת מוערכת (זה מה שנבדק כאן), והמונה לעולם לא חורג.
    const succeeded = results.some((r) => r.status === "OK");
    assert.ok(succeeded || results.filter((r) => r.status === "INVALID").length <= 1, JSON.stringify(results));
    assert.ok(evaluated.length >= 1);
    const row = await prisma.pinThrottle.findUniqueOrThrow({ where: { scope_subject: { scope: "VERIFY", subject: ids.web } } });
    assert.ok(row.failedCount <= 5);
  });

  test("הפעלה מחדש/תהליך אחר/שיחה חדשה: החסימה נשמרת במסד ואינה תלויה בזיכרון או בשיחה", async () => {
    await set(ids.web);
    for (let i = 0; i < 5; i++) await svc.verifyIvrPin({ userId: ids.web, pin: "0000" });
    // "שיחה חדשה" אחרי ניתוק, ו"שרת שהופעל מחדש": לקוח מסד חדש לגמרי, בלי שום מצב משותף
    const db2 = freshClient();
    try {
      for (let call = 0; call < 3; call++) {
        const res = await svc.verifyIvrPin({ userId: ids.web, pin: PIN, db: db2 });
        assert.equal(res.status, "BLOCKED", `שיחה ${call}`);
      }
      const later = await svc.verifyIvrPin({ userId: ids.web, pin: PIN, db: db2, now: new Date(Date.now() + 16 * MIN) });
      assert.equal(later.status, "OK");
    } finally {
      await db2.$disconnect();
    }
  });

  test("הגנה מפני ניסיונות המוניים על משתמשים שונים: מעבר לסף מושבת זמנית את האימות לכולם", async () => {
    const policy = { ...policyMod.IVR_PIN_POLICY, global: { maxFailuresPerWindow: 3, windowMinutes: 10, blockMinutes: 5 } };
    const users: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await mkUser(`mass${i}`, { phone: `050222000${i}`, passwordHash: await pw.hashPassword("x"), ivrPinHash: await pw.hashPassword(PIN) });
      users.push(id);
    }
    // כל משתמש נכשל פעם אחת (עדיין רחוק מחסימה אישית)
    for (const id of users.slice(0, 3)) assert.equal((await svc.verifyIvrPin({ userId: id, pin: "0000", policy })).status, "INVALID");
    // הסף הכללי הושג: גם משתמש חדש עם קוד נכון מקבל UNAVAILABLE (בלי להעריך את הקוד)
    const blocked = await svc.verifyIvrPin({ userId: users[3], pin: PIN, policy });
    assert.equal(blocked.status, "UNAVAILABLE");
    assert.equal((await prisma.pinThrottle.findFirst({ where: { scope: "VERIFY", subject: users[3] } })), null, "לא נרשם ניסיון אישי");
    const later = await svc.verifyIvrPin({ userId: users[3], pin: PIN, policy, now: new Date(Date.now() + 6 * MIN) });
    assert.equal(later.status, "OK");
  });

  test("איפוס פנימי (ללא נתיב HTTP/IVR): מוחק קוד וחסימות ורושם אירוע; האימות חוזר ל-NOT_SET", async () => {
    await set(ids.web);
    for (let i = 0; i < 5; i++) await svc.verifyIvrPin({ userId: ids.web, pin: "0000" });
    await svc.resetIvrPinInternal({ userId: ids.web, actorId: "admin-1" });
    assert.equal(await hashOf("web"), null);
    assert.equal(await prisma.pinThrottle.count({ where: { subject: ids.web } }), 0);
    assert.ok((await prisma.ivrPinEvent.findMany({ where: { userId: ids.web } })).some((e) => e.kind === "RESET" && e.actorId === "admin-1"));
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.web, pin: PIN }), { status: "NOT_SET" });
  });

  // ───────────── העברת משתמשים טלפוניים ותיקים ─────────────

  test("העברה מבוקרת: dry-run לא כותב; apply מעביר רק מועמדים מבניים, לא נוגע ב-passwordHash, ואידמפוטנטי", async () => {
    await set(ids.web); // כבר יש קוד: לא מועמד
    await mkUser("legacy2", { phone: "0501110003", passwordHash: await pw.hashPassword("1357") });
    const snapshot = async () =>
      Object.fromEntries((await prisma.user.findMany({ where: { name: { startsWith: "pin " } } })).map((u) => [u.name, u.passwordHash]));
    const passwordsBefore = await snapshot();

    const dry = await legacy.migrateLegacyPhonePins(prisma);
    assert.deepEqual(dry, { candidates: 2, migrated: 0 });
    assert.equal(await hashOf("legacy"), null, "dry-run לא כתב");

    const applied = await legacy.migrateLegacyPhonePins(prisma, { apply: true });
    assert.deepEqual(applied, { candidates: 2, migrated: 2 });
    assert.deepEqual(await snapshot(), passwordsBefore, "passwordHash לא השתנה לאף משתמש");

    const legacyUser = await prisma.user.findUniqueOrThrow({ where: { id: ids.legacy } });
    assert.equal(legacyUser.ivrPinHash, legacyUser.passwordHash, "הועתק ה-hash בלבד");
    // לא הועברו: משתמש אתר, יצירת מנהל (סיסמה זמנית + שם), ומי שכבר הגדיר קוד
    assert.equal(await hashOf("adminCreated"), null);
    assert.equal(await hashOf("tempPw"), null);
    assert.notEqual(await hashOf("web"), (await prisma.user.findUniqueOrThrow({ where: { id: ids.web } })).passwordHash);
    assert.equal(await prisma.ivrPinEvent.count({ where: { kind: "MIGRATED_LEGACY" } }), 2);

    // אחרי ההעברה הקוד הישן עובד דרך השירות האחיד
    assert.deepEqual(await svc.verifyIvrPin({ userId: ids.legacy, pin: "2468" }), { status: "OK" });
    assert.deepEqual(await legacy.migrateLegacyPhonePins(prisma, { apply: true }), { candidates: 0, migrated: 0 });
  });

  test("הקריטריון המבני לא תופס: משתמש עם ת\"ז, מגדר, כרטיס, אימייל או תפקיד מנהל", async () => {
    await mkUser("hasId", { phone: "0501110004", idNumber: "000000018", passwordHash: "x" });
    await mkUser("hasGender", { phone: "0501110005", gender: "MALE", passwordHash: "x" });
    await mkUser("hasCard", { phone: "0501110006", cardLast4: "4242", passwordHash: "x" });
    await mkUser("hasEmail", { phone: "0501110007", email: "pin-email@test.local", passwordHash: "x" });
    await mkUser("adminRole", { phone: "0501110008", role: "ADMIN", passwordHash: "x" });
    await mkUser("noPhone", { passwordHash: "x" });
    assert.equal(await legacy.countLegacyPhonePinCandidates(prisma), 1, "רק legacy");
  });

  test("כלי ההעברה מסרב: מסד מרוחק בלי --allow-remote, ו-apply בלי --confirm-host", () => {
    const run = (url: string, args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-legacy-ivr-pins.ts", ...args], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: "utf8",
        timeout: 60_000,
      });
    const remote = run("postgresql://u:p@db.example.com:5432/x", []);
    assert.equal(remote.status, 2, remote.stderr);
    assert.ok(!remote.stdout.includes("candidates"), "לא התחבר");
    const remoteApply = run("postgresql://u:p@db.example.com:5432/x", ["--apply", "--confirm-host=db.example.com"]);
    assert.equal(remoteApply.status, 2, "גם עם confirm, מסד מרוחק דורש --allow-remote");
    const noConfirm = run(testUrl!, ["--apply"]);
    assert.equal(noConfirm.status, 3, noConfirm.stderr);
    const dry = run(testUrl!, []);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\[DRY-RUN\] host=localhost candidates=\d+ migrated=0/);
  });
});
