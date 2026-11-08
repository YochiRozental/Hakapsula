/** גודל קובץ מרבי לתמונת גלריה (בייטים) */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type Signature = { mime: string; check: (buf: Buffer) => boolean };

const SIGNATURES: Signature[] = [
  { mime: "image/jpeg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    check: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/gif",
    check: (b) =>
      b.length > 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a"),
  },
  {
    mime: "image/webp",
    check: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
];

/** מזהה את סוג הקובץ האמיתי לפי בתי הזיהוי (magic bytes), ללא תלות ב-Content-Type שהלקוח טען */
export function detectRealImageType(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (sig.check(buffer)) return sig.mime;
  }
  return null;
}
