import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRealImageType } from "@/lib/gallery/validate-image";

test("מזהה JPEG לפי בתי הזיהוי", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectRealImageType(buf), "image/jpeg");
});

test("מזהה PNG לפי בתי הזיהוי", () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(detectRealImageType(buf), "image/png");
});

test("מזהה GIF לפי בתי הזיהוי (87a ו-89a)", () => {
  assert.equal(detectRealImageType(Buffer.from("GIF87a-rest")), "image/gif");
  assert.equal(detectRealImageType(Buffer.from("GIF89a-rest")), "image/gif");
});

test("מזהה WEBP לפי בתי הזיהוי (RIFF...WEBP)", () => {
  const buf = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBP"),
  ]);
  assert.equal(detectRealImageType(buf), "image/webp");
});

test("קובץ שאינו תמונה (או שקרן על סוגו) נדחה", () => {
  assert.equal(detectRealImageType(Buffer.from("<?php echo 'evil'; ?>")), null);
  assert.equal(detectRealImageType(Buffer.from([0x25, 0x50, 0x44, 0x46])), null); // %PDF
});

test("בתי התחלה של פורמט אחר לא מתבלבלים עם פורמט דומה", () => {
  // GIF-ish אבל לא תקין
  assert.equal(detectRealImageType(Buffer.from("GIF00a-rest")), null);
  // RIFF בלי WEBP באמצע
  const notWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("AVI ")]);
  assert.equal(detectRealImageType(notWebp), null);
});
