import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOURS_PACKAGES,
  allocatePackageMinutes,
  formatAgorot,
  packageExpiry,
  packageSavingsAgorot,
  regularPriceAgorot,
  splitBookingPrice,
} from "@/lib/payments/pricing";
import { creditExpiry, isAutoRefundEligible } from "@/lib/payments/policy";

test("regular price: 75 per hour, 18.75 per quarter hour", () => {
  assert.equal(regularPriceAgorot(15), 1875);
  assert.equal(regularPriceAgorot(60), 7500);
  assert.equal(regularPriceAgorot(90), 11250);
  assert.throws(() => regularPriceAgorot(20), RangeError);
  assert.throws(() => regularPriceAgorot(0), RangeError);
});

test("package prices match the price list and are cheaper than regular", () => {
  assert.deepEqual(
    HOURS_PACKAGES.map((p) => [p.hours, p.priceAgorot]),
    [[5, 30000], [10, 55000], [20, 100000]]
  );
  for (const p of HOURS_PACKAGES) assert.ok(packageSavingsAgorot(p) > 0);
  assert.equal(packageSavingsAgorot(HOURS_PACKAGES[0]), 5 * 7500 - 30000);
});

test("package expires one year after purchase, leap day clamped", () => {
  assert.equal(packageExpiry(new Date("2026-03-10T08:00:00Z")).toISOString(), "2027-03-10T08:00:00.000Z");
  assert.equal(packageExpiry(new Date("2028-02-29T08:00:00Z")).toISOString(), "2029-02-28T08:00:00.000Z");
});

const now = new Date("2026-06-01T00:00:00Z");

test("allocation uses the package that expires first", () => {
  const result = allocatePackageMinutes(
    [
      { id: "late", expiresAt: new Date("2027-01-01Z"), minutesRemaining: 120 },
      { id: "soon", expiresAt: new Date("2026-07-01Z"), minutesRemaining: 45 },
    ],
    90,
    now
  );
  assert.deepEqual(result.allocations, [
    { packageId: "soon", minutes: 45 },
    { packageId: "late", minutes: 45 },
  ]);
  assert.equal(result.shortfallMinutes, 0);
});

test("allocation ignores expired and empty packages and reports shortfall", () => {
  const result = allocatePackageMinutes(
    [
      { id: "expired", expiresAt: new Date("2026-05-31Z"), minutesRemaining: 600 },
      { id: "expires-now", expiresAt: now, minutesRemaining: 600 },
      { id: "empty", expiresAt: new Date("2026-08-01Z"), minutesRemaining: 0 },
      { id: "ok", expiresAt: new Date("2026-09-01Z"), minutesRemaining: 30 },
    ],
    60,
    now
  );
  assert.deepEqual(result.allocations, [{ packageId: "ok", minutes: 30 }]);
  assert.equal(result.shortfallMinutes, 30);
});

test("allocation does not mutate its input", () => {
  const pkgs = [{ id: "a", expiresAt: new Date("2027-01-01Z"), minutesRemaining: 60 }];
  allocatePackageMinutes(pkgs, 30, now);
  assert.equal(pkgs[0].minutesRemaining, 60);
});

test("booking split combines package balance with regular payment", () => {
  const pkgs = [{ id: "a", expiresAt: new Date("2027-01-01Z"), minutesRemaining: 45 }];
  const split = splitBookingPrice(60, pkgs, now);
  assert.equal(split.packageMinutes, 45);
  assert.equal(split.regularMinutes, 15);
  assert.equal(split.regularPriceAgorot, 1875);

  const full = splitBookingPrice(30, pkgs, now);
  assert.equal(full.regularPriceAgorot, 0);

  const none = splitBookingPrice(60, [], now);
  assert.equal(none.regularPriceAgorot, 7500);
});

test("cancellation: no automatic refund within 24h of start, unless admin exception", () => {
  const start = new Date("2026-06-10T10:00:00Z");
  assert.equal(isAutoRefundEligible({ startTime: start, now: new Date("2026-06-08T10:00:00Z") }), true);
  assert.equal(isAutoRefundEligible({ startTime: start, now: new Date("2026-06-09T10:00:00Z") }), true);
  assert.equal(isAutoRefundEligible({ startTime: start, now: new Date("2026-06-09T10:00:01Z") }), false);
  assert.equal(isAutoRefundEligible({ startTime: start, now: new Date("2026-06-10T09:00:00Z") }), false);
  assert.equal(isAutoRefundEligible({ startTime: start, now: new Date("2026-06-10T09:00:00Z"), adminException: true }), true);
});

test("credit is valid for 30 days", () => {
  assert.equal(creditExpiry(new Date("2026-06-01T00:00:00Z")).toISOString(), "2026-07-01T00:00:00.000Z");
});

test("formatAgorot", () => {
  assert.equal(formatAgorot(4160), "41.60");
  assert.equal(formatAgorot(5), "0.05");
  assert.equal(formatAgorot(275600), "2756.00");
});
