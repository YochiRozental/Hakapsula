import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { getPaymentProvider, isLocalDatabaseUrl, type PaymentEnv } from "@/lib/payments/config";
import {
  IdempotencyConflictError,
  PaymentConfigError,
  PaymentStateError,
  WebhookVerificationError,
} from "@/lib/payments/provider";

const SECRET = "test-webhook-secret-0123456789";

function makeProvider() {
  return new MockPaymentProvider(SECRET);
}

const baseRequest = {
  amountAgorot: 5200,
  currency: "ILS" as const,
  description: "test",
  customerRef: "user-1",
};

test("payment lifecycle: success is only visible via server-side status", async () => {
  const p = makeProvider();
  const created = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  assert.equal(created.status, "PENDING");
  assert.equal((await p.getPaymentStatus(created.providerPaymentId)).status, "PENDING");

  await p.completeCheckout(created.providerPaymentId, "success");
  const status = await p.getPaymentStatus(created.providerPaymentId);
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.amountAgorot, 5200);
});

test("failed payment", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "failure");
  const status = await p.getPaymentStatus(providerPaymentId);
  assert.equal(status.status, "FAILED");
  assert.ok(status.failureCode);
  await assert.rejects(() => p.refund({ providerPaymentId, idempotencyKey: "r1" }), PaymentStateError);
});

test("idempotency: same key returns the same payment, different params conflict", async () => {
  const p = makeProvider();
  const a = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "same" });
  const b = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "same" });
  assert.equal(a.providerPaymentId, b.providerPaymentId);
  await assert.rejects(
    () => p.createPaymentRequest({ ...baseRequest, amountAgorot: 9999, idempotencyKey: "same" }),
    IdempotencyConflictError
  );
});

test("cancel: pending only, repeat is a no-op", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.cancelPayment(providerPaymentId);
  await p.cancelPayment(providerPaymentId);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).status, "CANCELLED");

  const paid = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k2" });
  await p.completeCheckout(paid.providerPaymentId, "success");
  await assert.rejects(() => p.cancelPayment(paid.providerPaymentId), PaymentStateError);
});

test("partial and full refunds, never above the paid amount, idempotent", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "success");

  const r1 = await p.refund({ providerPaymentId, amountAgorot: 2000, idempotencyKey: "r1" });
  assert.equal(r1.amountAgorot, 2000);
  const r1again = await p.refund({ providerPaymentId, amountAgorot: 2000, idempotencyKey: "r1" });
  assert.equal(r1again.providerRefundId, r1.providerRefundId);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).refundedAgorot, 2000);

  await assert.rejects(
    () => p.refund({ providerPaymentId, amountAgorot: 3201, idempotencyKey: "r2" }),
    PaymentStateError
  );
  await assert.rejects(
    () => p.refund({ providerPaymentId, amountAgorot: 1, idempotencyKey: "r1" }),
    IdempotencyConflictError
  );

  const rest = await p.refund({ providerPaymentId, idempotencyKey: "r3" });
  assert.equal(rest.amountAgorot, 3200);
  assert.equal((await p.getPaymentStatus(providerPaymentId)).refundedAgorot, 5200);
});

test("saved payment method: token only, variable-amount recurring charge", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({
    ...baseRequest,
    idempotencyKey: "k1",
    savePaymentMethod: true,
  });
  await p.completeCheckout(providerPaymentId, "success");
  const method = (await p.getPaymentStatus(providerPaymentId)).savedPaymentMethod;
  assert.ok(method?.token);
  assert.deepEqual(Object.keys(method!).sort(), ["brand", "expiry", "last4", "token"]);

  const month1 = await p.chargeSavedMethod({
    token: method!.token,
    amountAgorot: 66560,
    currency: "ILS",
    description: "month 1",
    idempotencyKey: "m1",
    customerRef: "user-1",
  });
  assert.equal(month1.status, "SUCCEEDED");
  const retry = await p.chargeSavedMethod({
    token: method!.token,
    amountAgorot: 66560,
    currency: "ILS",
    description: "month 1",
    idempotencyKey: "m1",
    customerRef: "user-1",
  });
  assert.equal(retry.providerPaymentId, month1.providerPaymentId);

  await p.declineToken(method!.token);
  const declined = await p.chargeSavedMethod({
    token: method!.token,
    amountAgorot: 83200,
    currency: "ILS",
    description: "month 2",
    idempotencyKey: "m2",
    customerRef: "user-1",
  });
  assert.equal(declined.status, "FAILED");

  const unknown = await p.chargeSavedMethod({
    token: "nope",
    amountAgorot: 100,
    currency: "ILS",
    description: "x",
    idempotencyKey: "m3",
    customerRef: "user-1",
  });
  assert.equal(unknown.status, "FAILED");
});

test("a payment is not saved as a method unless requested", async () => {
  const p = makeProvider();
  const { providerPaymentId } = await p.createPaymentRequest({ ...baseRequest, idempotencyKey: "k1" });
  await p.completeCheckout(providerPaymentId, "success");
  assert.equal((await p.getPaymentStatus(providerPaymentId)).savedPaymentMethod, undefined);
});

test("amounts must be positive integers", async () => {
  const p = makeProvider();
  for (const amountAgorot of [0, -5, 10.5]) {
    await assert.rejects(() => p.createPaymentRequest({ ...baseRequest, amountAgorot, idempotencyKey: `k${amountAgorot}` }));
  }
});

test("webhook: valid signature accepted, tampering and missing signature rejected", async () => {
  const p = makeProvider();
  const event = { eventId: "evt_1", type: "payment.updated" as const, providerPaymentId: "mock_pay_x" };
  const signed = p.buildWebhook(event);
  assert.deepEqual(await p.parseWebhook(signed), event);

  await assert.rejects(
    () => p.parseWebhook({ ...signed, rawBody: signed.rawBody.replace("mock_pay_x", "mock_pay_y") }),
    WebhookVerificationError
  );
  await assert.rejects(() => p.parseWebhook({ rawBody: signed.rawBody, headers: {} }), WebhookVerificationError);

  const other = new MockPaymentProvider("another-secret-0123456789").buildWebhook(event);
  await assert.rejects(() => p.parseWebhook(other), WebhookVerificationError);
});

// ---- הפרדת Mock מסליקה אמיתית ----

const goodEnv: PaymentEnv = {
  NODE_ENV: "development",
  PAYMENT_PROVIDER: "mock",
  PAYMENT_ENVIRONMENT: "sandbox",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_WEBHOOK_SECRET: SECRET,
  DATABASE_URL: "postgresql://u:p@localhost:5433/clinics_payments_dev",
};

test("mock provider is created only when every guard passes", () => {
  assert.equal(getPaymentProvider(goodEnv).name, "mock");
});

test("mock is refused when any single guard fails", () => {
  const broken: PaymentEnv[] = [
    { ...goodEnv, NODE_ENV: "production" },
    { ...goodEnv, PAYMENT_ENVIRONMENT: "live" },
    { ...goodEnv, PAYMENT_ENVIRONMENT: undefined },
    { ...goodEnv, PAYMENT_MOCK_ENABLED: undefined },
    { ...goodEnv, PAYMENT_MOCK_ENABLED: "yes" },
    { ...goodEnv, PAYMENT_WEBHOOK_SECRET: undefined },
    { ...goodEnv, PAYMENT_WEBHOOK_SECRET: "short" },
    { ...goodEnv, DATABASE_URL: undefined },
    { ...goodEnv, DATABASE_URL: "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb" },
    { ...goodEnv, DATABASE_URL: "not a url" },
  ];
  for (const env of broken) {
    assert.throws(() => getPaymentProvider(env), PaymentConfigError, JSON.stringify(env));
  }
});

test("mock stays refused on a production build even with sandbox flags and a local DB", () => {
  assert.throws(() => getPaymentProvider({ ...goodEnv, NODE_ENV: "production" }), PaymentConfigError);
});

test("error messages never leak the secret or the database URL", () => {
  try {
    getPaymentProvider({ ...goodEnv, DATABASE_URL: "postgresql://user:hunter2@db.example.com/x", PAYMENT_ENVIRONMENT: "live" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof PaymentConfigError);
    assert.ok(!err.message.includes("hunter2"));
    assert.ok(!err.message.includes("db.example.com"));
    assert.ok(!err.message.includes(SECRET));
  }
});

test("no provider configured, unknown, and unimplemented payme all refuse", () => {
  assert.throws(() => getPaymentProvider({}), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "none" }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "stripe" }), PaymentConfigError);
  assert.throws(() => getPaymentProvider({ PAYMENT_PROVIDER: "payme", PAYMENT_ENVIRONMENT: "live" }), /לא ממומש/);
});

test("isLocalDatabaseUrl", () => {
  assert.equal(isLocalDatabaseUrl("postgresql://a:b@localhost:5433/x"), true);
  assert.equal(isLocalDatabaseUrl("postgresql://a:b@127.0.0.1/x"), true);
  assert.equal(isLocalDatabaseUrl("postgresql://a:b@[::1]:5432/x"), true);
  assert.equal(isLocalDatabaseUrl("postgresql://a:b@localhost.evil.com/x"), false);
  assert.equal(isLocalDatabaseUrl("postgresql://a:b@ep-x.neon.tech/x"), false);
  assert.equal(isLocalDatabaseUrl(undefined), false);
});
