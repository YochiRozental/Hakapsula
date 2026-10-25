import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppointment } from "@/lib/booking";
import { prisma } from "@/lib/prisma";
import { jerusalemParts } from "@/lib/opening-hours";

// יום שני (מסלול בנים כברירת מחדל) בעוד כ-60 יום, 12:00–13:00 לפי ירושלים — בתוך 08:00–21:00
function futureMondayNoon() {
  const d = new Date();
  d.setDate(d.getDate() + 60);
  while (jerusalemParts(d).weekday !== 1) d.setDate(d.getDate() + 1);
  d.setUTCHours(10, 0, 0, 0);
  return { start: d, end: new Date(d.getTime() + 3600_000) };
}

const FULL_USER = {
  id: "u1",
  name: "משתמש בדיקה",
  email: "a@b.co",
  phone: "0501234567",
  idNumber: "000000018",
  cardLast4: "4242",
  cardExpiry: "12/40",
  passwordHash: "HASH",
  gender: "MALE",
};

type Include = { room?: unknown; user?: true | { select?: Record<string, boolean> } };

/** מחליף את הגישה למסד בכפילים בזיכרון; ה-create מחזיר את רשומת המשתמש המלאה מסוננת לפי ה-select שנשלח (כמו Prisma) */
function stubDatabase() {
  const calls: { include?: Include } = {};
  const db = prisma as unknown as Record<string, Record<string, unknown>> & { $transaction: unknown };
  const original = {
    transaction: db.$transaction,
    roomFindMany: db.room.findMany,
    roomFindUnique: db.room.findUnique,
    userFindUnique: db.user.findUnique,
    windowFindMany: db.openingWindow.findMany,
  };
  db.room.findMany = async () => [
    { key: "ROOM1" }, { key: "ROOM2" }, { key: "ROOM3" }, { key: "ROOM4" }, { key: "WORKSHOP" }, { key: "ROOM1_2" },
  ];
  db.room.findUnique = async () => ({ id: "r1", key: "ROOM1", name: "חדר 1", active: true });
  db.user.findUnique = async () => ({ gender: "MALE" });
  db.openingWindow.findMany = async () => [];
  db.$transaction = async (fn: (tx: unknown) => unknown) =>
    fn({
      appointment: {
        findMany: async () => [],
        create: async ({ data, include }: { data: Record<string, unknown>; include: Include }) => {
          calls.include = include;
          const select = typeof include.user === "object" ? include.user.select : undefined;
          const user = select
            ? Object.fromEntries(Object.entries(FULL_USER).filter(([k]) => select[k]))
            : FULL_USER;
          return { id: "a1", ...data, status: "CONFIRMED", room: { id: "r1", key: "ROOM1", name: "חדר 1" }, user };
        },
      },
    });
  return {
    calls,
    restore() {
      db.$transaction = original.transaction;
      db.room.findMany = original.roomFindMany;
      db.room.findUnique = original.roomFindUnique;
      db.user.findUnique = original.userFindUnique;
      db.openingWindow.findMany = original.windowFindMany;
    },
  };
}

test("createAppointment: התגובה לא חושפת passwordHash, ת\"ז, כרטיס או פרטי קשר, ושומרת על מבנה ההזמנה", async () => {
  const stub = stubDatabase();
  try {
    const { start, end } = futureMondayNoon();
    const result = await createAppointment({ userId: "u1", roomKey: "ROOM1", startTime: start, endTime: end, source: "WEB", notes: "n" });

    // המבנה הקיים נשמר: מזהה, חדר, סטטוס, מקור והערות, ומשתמש עם id ושם
    assert.equal(result.id, "a1");
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.source, "WEB");
    assert.equal(result.notes, "n");
    assert.equal(result.userId, "u1");
    assert.equal(result.room.key, "ROOM1");
    assert.deepEqual(result.user, { id: "u1", name: "משתמש בדיקה" });

    // אף שדה רגיש לא מוחזר, ולא נבקש אותו מהמסד
    const json = JSON.stringify(result);
    for (const secret of ["passwordHash", "HASH", "idNumber", "000000018", "cardLast4", "4242", "cardExpiry", "a@b.co", "0501234567"]) {
      assert.ok(!json.includes(secret), `התגובה לא אמורה לכלול ${secret}`);
    }
    assert.notEqual(stub.calls.include?.user, true);
  } finally {
    stub.restore();
  }
});
