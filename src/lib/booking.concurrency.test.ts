import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BookingSource, RoomKey } from "@/generated/prisma/client";

// בדיקות מקביליות אמיתיות מול PostgreSQL מקומי ייעודי. רצות רק כש-TEST_DATABASE_URL מוגדר ומצביע על מסד מקומי בשם *_test.
// מריצים עם: TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/clinics_test npm test
const testUrl = process.env.TEST_DATABASE_URL;

function assertLocalTestDatabase(url: string) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const name = parsed.pathname.replace(/^\//, "");
  if (!local || !name.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL חייב להצביע על מסד מקומי ששמו מסתיים ב-_test");
  }
}

describe("createAppointment: מקביליות מול PostgreSQL מקומי", { skip: !testUrl && "TEST_DATABASE_URL לא מוגדר" }, () => {
  type Mods = {
    prisma: typeof import("@/lib/prisma").prisma;
    createAppointment: typeof import("@/lib/booking").createAppointment;
    cancelAppointment: typeof import("@/lib/booking").cancelAppointment;
    BookingError: typeof import("@/lib/booking").BookingError;
  };
  let m: Mods;
  let userIds: string[] = [];
  let adminId: string;
  const stats = { bookingErrors: 0, otherErrors: [] as string[] };

  // יום שני בעוד כ-90 יום (מסלול בנים כברירת מחדל, 08:00–21:00 בלי חלונות מפורשים במסד הבדיקות)
  let mondayMs: number;
  const slot = (hour: number) => {
    const start = new Date(mondayMs + hour * 3600_000);
    return { startTime: start, endTime: new Date(start.getTime() + 3600_000) };
  };

  before(async () => {
    assertLocalTestDatabase(testUrl!);
    process.env.DATABASE_URL = testUrl;
    const { prisma } = await import("@/lib/prisma");
    const booking = await import("@/lib/booking");
    const { jerusalemParts } = await import("@/lib/opening-hours");
    m = { prisma, ...booking };

    const d = new Date();
    d.setDate(d.getDate() + 90);
    while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    mondayMs = d.getTime();

    await prisma.appointment.deleteMany({});
    await prisma.user.deleteMany({ where: { email: { startsWith: "conc-" } } });
    const users = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        prisma.user.create({
          data: { name: `conc ${i}`, email: `conc-${i}@test.local`, passwordHash: "x", gender: "MALE", status: "APPROVED" },
        })
      )
    );
    userIds = users.map((u) => u.id);
    adminId = (
      await prisma.user.create({
        data: { name: "conc admin", email: "conc-admin@test.local", passwordHash: "x", role: "ADMIN", status: "APPROVED" },
      })
    ).id;
  });

  after(async () => {
    if (!m) return;
    await m.prisma.appointment.deleteMany({});
    await m.prisma.user.deleteMany({ where: { email: { startsWith: "conc-" } } });
    await m.prisma.$disconnect();
    console.log(`[concurrency] BookingError=${stats.bookingErrors} שגיאות אחרות=${stats.otherErrors.length}`, stats.otherErrors);
  });

  const reset = () => m.prisma.appointment.deleteMany({});

  /** מריץ הזמנות במקביל; מסווג לתוצאות הצלחה, BookingError (תפוס), ושגיאות אחרות (timeout/deadlock וכו') */
  async function race(requests: { userId: string; roomKey: RoomKey; hour: number; source: BookingSource }[]) {
    const results = await Promise.allSettled(
      requests.map((r) => m.createAppointment({ userId: r.userId, roomKey: r.roomKey, source: r.source, ...slot(r.hour) }))
    );
    let ok = 0;
    let busy = 0;
    const other: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else if (r.reason instanceof m.BookingError) {
        busy++;
        stats.bookingErrors++;
      } else {
        other.push(String(r.reason));
        stats.otherErrors.push(String(r.reason));
      }
    }
    return { ok, busy, other };
  }

  const confirmedCount = () => m.prisma.appointment.count({ where: { status: "CONFIRMED" } });

  test("20 בקשות מקבילות לאותו חדר ואותה שעה (WEB/ADMIN/IVR): בדיוק אחת מצליחה", async () => {
    const sources: BookingSource[] = ["WEB", "ADMIN", "IVR"];
    for (let round = 0; round < 5; round++) {
      await reset();
      const requests = Array.from({ length: 20 }, (_, i) => ({
        userId: i % 7 === 0 ? adminId : userIds[i],
        roomKey: "ROOM3" as RoomKey,
        hour: 10,
        source: sources[i % 3],
      }));
      const r = await race(requests);
      assert.deepEqual(r.other, [], "אין שגיאות timeout/deadlock");
      assert.equal(r.ok, 1, `סבב ${round}: הצלחה אחת בלבד`);
      assert.equal(r.busy, 19);
      assert.equal(await confirmedCount(), 1);
    }
  });

  test("ROOM1 מול ROOM1_2 במקביל: בדיוק אחת מצליחה (30 סבבים)", async () => {
    for (let round = 0; round < 30; round++) {
      await reset();
      const r = await race([
        { userId: userIds[0], roomKey: "ROOM1", hour: 11, source: "WEB" },
        { userId: userIds[1], roomKey: "ROOM1_2", hour: 11, source: "WEB" },
      ]);
      assert.deepEqual(r.other, []);
      assert.equal(r.ok, 1, `סבב ${round}`);
      assert.equal(r.busy, 1);
      assert.equal(await confirmedCount(), 1);
    }
  });

  test("ROOM2 מול ROOM1_2, ועוד ROOM1 ו-ROOM2 יחד מול ROOM1_2: לעולם לא חפיפה פיזית", async () => {
    for (let round = 0; round < 20; round++) {
      await reset();
      const r = await race([
        { userId: userIds[0], roomKey: "ROOM1", hour: 12, source: "WEB" },
        { userId: userIds[1], roomKey: "ROOM2", hour: 12, source: "IVR" },
        { userId: userIds[2], roomKey: "ROOM1_2", hour: 12, source: "ADMIN" },
        { userId: userIds[3], roomKey: "ROOM1_2", hour: 12, source: "WEB" },
      ]);
      assert.deepEqual(r.other, []);
      const rows = await m.prisma.appointment.findMany({ include: { room: true } });
      const keys = rows.map((x) => x.room.key).sort();
      // או שני החדרים הבודדים, או החדר המשולב לבדו — אף פעם לא ערבוב
      const valid =
        (keys.length === 2 && keys[0] === "ROOM1" && keys[1] === "ROOM2") || (keys.length === 1 && keys[0] === "ROOM1_2");
      assert.ok(valid, `סבב ${round}: ${keys.join(",")}`);
    }
  });

  test("ROOM1 ו-ROOM2 במקביל באותה שעה: שתיהן מצליחות", async () => {
    for (let round = 0; round < 10; round++) {
      await reset();
      const r = await race([
        { userId: userIds[0], roomKey: "ROOM1", hour: 13, source: "WEB" },
        { userId: userIds[1], roomKey: "ROOM2", hour: 13, source: "WEB" },
      ]);
      assert.deepEqual(r.other, []);
      assert.equal(r.ok, 2);
    }
  });

  test("חדרים עצמאיים (ROOM3, ROOM4, WORKSHOP) ו-ROOM1 במקביל: כולם מצליחים", async () => {
    for (let round = 0; round < 10; round++) {
      await reset();
      const r = await race([
        { userId: userIds[0], roomKey: "ROOM3", hour: 14, source: "WEB" },
        { userId: userIds[1], roomKey: "ROOM4", hour: 14, source: "IVR" },
        { userId: userIds[2], roomKey: "WORKSHOP", hour: 14, source: "ADMIN" },
        { userId: userIds[3], roomKey: "ROOM1", hour: 14, source: "WEB" },
      ]);
      assert.deepEqual(r.other, []);
      assert.equal(r.ok, 4);
    }
  });

  test("ביטול והזמנה במקביל לאותו חלון: ביטול תמיד מצליח, אין כפילות", async () => {
    for (let round = 0; round < 20; round++) {
      await reset();
      const first = await m.createAppointment({ userId: userIds[0], roomKey: "ROOM1", source: "WEB", ...slot(15) });
      const [cancel, book] = await Promise.allSettled([
        m.cancelAppointment(first.id, { id: userIds[0], role: "CLIENT" }),
        m.createAppointment({ userId: userIds[1], roomKey: "ROOM1_2", source: "WEB", ...slot(15) }),
      ]);
      assert.equal(cancel.status, "fulfilled");
      if (book.status === "rejected") {
        assert.ok(book.reason instanceof m.BookingError, String(book.reason));
        stats.bookingErrors++;
      }
      assert.ok((await confirmedCount()) <= 1, `סבב ${round}: לכל היותר הזמנה מאושרת אחת`);
      // אחרי הביטול, החלון פנוי להזמנה חדשה (אם ההזמנה המקבילה נדחתה — היא מצליחה עכשיו)
      if (book.status === "rejected") {
        await m.createAppointment({ userId: userIds[2], roomKey: "ROOM1_2", source: "WEB", ...slot(15) });
      }
      assert.equal(await confirmedCount(), 1);
    }
  });

  test("המתנה לנעילה: הזמנה ממתינה עד שחרור נעילה מוחזקת ואז מצליחה", async () => {
    await reset();
    const holdMs = 1500;
    let released = false;
    const holder = m.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301::int, 3::int)`;
        await new Promise((r) => setTimeout(r, holdMs));
        released = true;
      },
      { timeout: 10_000 }
    );
    await new Promise((r) => setTimeout(r, 300)); // מבטיח שהנעילה כבר מוחזקת
    const t0 = Date.now();
    const appt = await m.createAppointment({ userId: userIds[0], roomKey: "ROOM4", source: "WEB", ...slot(16) });
    const waited = Date.now() - t0;
    await holder;
    assert.ok(released, "ההזמנה הושלמה רק אחרי שחרור הנעילה");
    assert.ok(waited >= holdMs - 500, `המתינה ${waited}ms`);
    assert.ok(appt.id);
    // נעילה של אזור אחר לא חוסמת
    assert.equal(await confirmedCount(), 1);
  });

  test("Timeout: נעילה מוחזקת מעבר ל-timeout של הטרנזקציה → כישלון נקי בלי הזמנה, והמערכת מתאוששת", async () => {
    await reset();
    let holderDone = false;
    const holder = m.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301::int, 2::int)`;
          await new Promise((r) => setTimeout(r, 7000));
        },
        { timeout: 15_000 }
      )
      .then(() => {
        holderDone = true;
      });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const result = await Promise.allSettled([
      m.createAppointment({ userId: userIds[0], roomKey: "ROOM3", source: "WEB", ...slot(17) }),
    ]);
    const elapsed = Date.now() - t0;
    console.log(`[concurrency] timeout: ${result[0].status}, ${elapsed}ms, ${result[0].status === "rejected" ? String(result[0].reason).slice(0, 120) : ""}`);
    await holder;
    assert.ok(holderDone);
    if (result[0].status === "rejected") {
      // נכשל (לא BookingError) — ללא הזמנה שנוצרה
      assert.ok(!(result[0].reason instanceof m.BookingError));
      assert.equal(await confirmedCount(), 0);
      assert.ok(elapsed < 8000, "לא נתקע ללא גבול");
    } else {
      assert.equal(await confirmedCount(), 1);
    }
    // התאוששות: אחרי השחרור, הזמנה לאותו אזור מצליחה
    await reset();
    const ok = await m.createAppointment({ userId: userIds[1], roomKey: "ROOM3", source: "WEB", ...slot(17) });
    assert.ok(ok.id);
  });
});
