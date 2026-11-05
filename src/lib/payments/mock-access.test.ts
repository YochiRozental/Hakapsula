import { test } from "node:test";
import assert from "node:assert/strict";
import { isMockAccessRestricted, isMockUserAllowed, mockTestUserEmails } from "@/lib/payments/mock-access";
import { getPaymentProvider } from "@/lib/payments/config";
import { PaymentError } from "@/lib/payments/provider";

// הגבלת תשלומי דמה למשתמשי בדיקה מורשים (אתר מותקן). פונקציות טהורות + ספק Mock בזיכרון, ללא מסד נתונים.

const deployedEnv = {
  NODE_ENV: "production",
  PAYMENT_PROVIDER: "mock",
  PAYMENT_ENVIRONMENT: "sandbox",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_MOCK_ALLOW_DEPLOYED: "true",
  PAYMENT_WEBHOOK_SECRET: "0123456789abcdef0123",
  DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/x",
  PAYMENT_MOCK_TEST_USERS: " Tester@Example.com , other@example.com ",
};

test("הגבלה חלה רק על Mock באתר מותקן; בהדגמה מקומית ובלי ספק אין הגבלה", () => {
  assert.equal(isMockAccessRestricted(deployedEnv), true);
  assert.equal(isMockAccessRestricted({ ...deployedEnv, PAYMENT_MOCK_ALLOW_DEPLOYED: "false" }), false);
  assert.equal(isMockAccessRestricted({ ...deployedEnv, PAYMENT_PROVIDER: "none" }), false);
  assert.equal(isMockAccessRestricted({}), false);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: "anyone@example.com" }, { PAYMENT_PROVIDER: "mock" }), true, "מקומי: פתוח לכולם");
});

test("מורשים: מנהל, ומשתמש שהאימייל שלו ברשימה (בלי הבחנת אותיות ורווחים); כל השאר נדחים; בלי רשימה רק מנהלים", () => {
  assert.deepEqual([...mockTestUserEmails(deployedEnv)].sort(), ["other@example.com", "tester@example.com"]);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: "TESTER@example.com" }, deployedEnv), true);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: "other@example.com" }, deployedEnv), true);
  assert.equal(isMockUserAllowed({ role: "ADMIN", email: null }, deployedEnv), true);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: "stranger@example.com" }, deployedEnv), false);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: null }, deployedEnv), false);
  assert.equal(isMockUserAllowed({ role: "CLIENT", email: "tester@example.com" }, { ...deployedEnv, PAYMENT_MOCK_TEST_USERS: "" }), false);
  assert.equal(isMockUserAllowed({ role: "ADMIN", email: "a@b.c" }, { ...deployedEnv, PAYMENT_MOCK_TEST_USERS: "" }), true);
});

test("ספק ה-Mock באתר מותקן אוכף בצד השרת: יצירת תשלום וחיוב אמצעי שמור נדחים ללקוח לא מורשה", async () => {
  const allowed = new Set(["u-test"]);
  const provider = getPaymentProvider(deployedEnv, { mockCustomerAllowed: async (id) => allowed.has(id) });
  const base = { amountAgorot: 1000, currency: "ILS" as const, description: "x", customerRef: "u-stranger" };
  await assert.rejects(() => provider.createPaymentRequest({ ...base, idempotencyKey: "k1" }), PaymentError);
  await assert.rejects(() => provider.chargeSavedMethod({ ...base, token: "tok", idempotencyKey: "k2" }), PaymentError);
  const ok = await provider.createPaymentRequest({ ...base, customerRef: "u-test", idempotencyKey: "k3" });
  assert.equal(ok.status, "PENDING");
});

test("בהדגמה מקומית (בלי PAYMENT_MOCK_ALLOW_DEPLOYED) הספק אינו מגביל לקוחות", async () => {
  const localEnv = { ...deployedEnv, NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@localhost:5433/x", PAYMENT_MOCK_ALLOW_DEPLOYED: undefined };
  const provider = getPaymentProvider(localEnv, { mockCustomerAllowed: async () => false });
  const res = await provider.createPaymentRequest({ amountAgorot: 1000, currency: "ILS", description: "x", customerRef: "anyone", idempotencyKey: "k9" });
  assert.equal(res.status, "PENDING");
});
