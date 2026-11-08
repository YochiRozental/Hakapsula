import { test } from "node:test";
import assert from "node:assert/strict";
import { signCloudinaryParams } from "@/lib/gallery/cloudinary";

test("חתימה דטרמיניסטית: אותם פרמטרים ואותו סוד -> אותה חתימה", () => {
  const a = signCloudinaryParams({ folder: "x", timestamp: 123 }, "secret");
  const b = signCloudinaryParams({ folder: "x", timestamp: 123 }, "secret");
  assert.equal(a, b);
});

test("חתימה היא SHA-1 הקסדצימלי (40 תווים)", () => {
  const sig = signCloudinaryParams({ public_id: "abc", timestamp: 123 }, "secret");
  assert.match(sig, /^[0-9a-f]{40}$/);
});

test("סדר המפתחות באובייקט לא משפיע על החתימה (ממוין לפני החיתום)", () => {
  const a = signCloudinaryParams({ timestamp: 123, folder: "x" }, "secret");
  const b = signCloudinaryParams({ folder: "x", timestamp: 123 }, "secret");
  assert.equal(a, b);
});

test("שינוי בפרמטר אחד משנה את החתימה", () => {
  const a = signCloudinaryParams({ public_id: "abc", timestamp: 123 }, "secret");
  const b = signCloudinaryParams({ public_id: "abcd", timestamp: 123 }, "secret");
  assert.notEqual(a, b);
});

test("שינוי בסוד משנה את החתימה", () => {
  const a = signCloudinaryParams({ public_id: "abc", timestamp: 123 }, "secret1");
  const b = signCloudinaryParams({ public_id: "abc", timestamp: 123 }, "secret2");
  assert.notEqual(a, b);
});
