import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyCaller, normalizeCallerPhone, type PhoneLookup } from "@/ivr/identify";

const user = { id: "u1", name: "דנה" };
const found = (status: string): PhoneLookup => async () => [{ ...user, status }];
const none: PhoneLookup = async () => [];
const neverCalled: PhoneLookup = async () => {
  throw new Error("lookup must not run");
};

test("APPROVED / PENDING / BLOCKED מזוהים לפי סטטוס", async () => {
  for (const status of ["APPROVED", "PENDING", "BLOCKED"] as const) {
    const r = await identifyCaller("0501234567", found(status));
    assert.deepEqual(r, { kind: status, phone: "0501234567", user });
  }
});

test("מספר לא רשום -> NOT_FOUND עם מספר מנורמל", async () => {
  assert.deepEqual(await identifyCaller("+972501234567", none), { kind: "NOT_FOUND", phone: "0501234567" });
});

test("מספר חסוי/חסר/לא תקין -> PRIVATE ללא חיפוש", async () => {
  for (const raw of ["AnonymousPhone", "", undefined, null, "unknown", "123", "0501234567abc", "1234567890123"]) {
    assert.deepEqual(await identifyCaller(raw, neverCalled), { kind: "PRIVATE" }, String(raw));
  }
});

test("כשל במסד -> ERROR (לא NOT_FOUND)", async () => {
  const r = await identifyCaller("0501234567", async () => {
    throw new Error("db down");
  });
  assert.deepEqual(r, { kind: "ERROR" });
});

test("התאמה דו-משמעית או סטטוס לא מוכר -> ERROR", async () => {
  const two: PhoneLookup = async () => [
    { ...user, status: "APPROVED" },
    { id: "u2", name: "אחר", status: "APPROVED" },
  ];
  assert.deepEqual(await identifyCaller("0501234567", two), { kind: "ERROR" });
  assert.deepEqual(await identifyCaller("0501234567", found("WHATEVER")), { kind: "ERROR" });
});

test("חיפוש יחיד: lookup נקרא פעם אחת עם 9 ספרות", async () => {
  const calls: string[] = [];
  await identifyCaller("050-123-4567", async (l9) => {
    calls.push(l9);
    return [];
  });
  assert.deepEqual(calls, ["501234567"]);
});

test("התוצאה לא מכילה שדות נוספים מהמסד (למשל passwordHash)", async () => {
  const leaky: PhoneLookup = async () => [{ ...user, status: "APPROVED", passwordHash: "x" } as never];
  const r = await identifyCaller("0501234567", leaky);
  assert.equal(r.kind, "APPROVED");
  if (r.kind === "APPROVED") assert.deepEqual(Object.keys(r.user).sort(), ["id", "name"]);
});

test("normalizeCallerPhone: פורמטים תקינים", () => {
  assert.equal(normalizeCallerPhone("0501234567"), "0501234567");
  assert.equal(normalizeCallerPhone("972501234567"), "0501234567");
  assert.equal(normalizeCallerPhone("021234567"), "021234567");
});
