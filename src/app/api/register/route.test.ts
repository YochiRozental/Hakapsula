import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/register/route";

/** מחליף את הגישה למסד בכפילים בזיכרון, כמו ב-booking.test.ts — אין צורך במסד אמיתי */
function stubPrisma() {
  const db = prisma as unknown as Record<string, Record<string, unknown>>;
  const original = {
    findUnique: db.user.findUnique,
    findFirst: db.user.findFirst,
    create: db.user.create,
  };
  const created: Record<string, unknown>[] = [];
  db.user.findUnique = async () => null; // האימייל עדיין לא רשום
  db.user.findFirst = async () => null; // אין התנגשות טלפון/ת"ז
  db.user.create = async ({ data }: { data: Record<string, unknown> }) => {
    created.push(data);
    return { id: "u1", email: data.email as string };
  };
  return {
    created,
    restore() {
      db.user.findUnique = original.findUnique;
      db.user.findFirst = original.findFirst;
      db.user.create = original.create;
    },
  };
}

function registerRequest(body: Record<string, unknown>) {
  return new Request("http://local.test/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("הרשמה מצליחה בלי מגדר, ואינה שומרת ערך עבורו", async () => {
  const stub = stubPrisma();
  try {
    const res = await POST(registerRequest({ email: "no-gender@test.local", password: "1234" }));
    assert.equal(res.status, 201);
    assert.equal(stub.created.length, 1);
    assert.equal("gender" in stub.created[0], false);
  } finally {
    stub.restore();
  }
});

test("מגדר שנשלח בטעות (לקוח ישן) מתעלם ולא נשמר — השדה הוסר לגמרי מההרשמה", async () => {
  const stub = stubPrisma();
  try {
    const res = await POST(
      registerRequest({ email: "legacy-client@test.local", password: "1234", gender: "MALE" })
    );
    assert.equal(res.status, 201);
    assert.equal(stub.created.length, 1);
    assert.equal("gender" in stub.created[0], false);
  } finally {
    stub.restore();
  }
});
