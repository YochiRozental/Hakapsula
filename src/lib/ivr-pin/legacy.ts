import type { PrismaClient } from "@/generated/prisma/client";

/**
 * העברה מבוקרת של קודים טלפוניים ותיקים מ-passwordHash אל ivrPinHash.
 *
 * הרקע: עד שלב F.2 הרשמה טלפונית שמרה את הקוד ב-passwordHash. אין עמודת מקור שמסמנת זאת, ולכן לא מנחשים לפי אורך
 * hash או קיום טלפון. הקריטריון כאן נשען על מסלול היצירה: במערכת רק הרשמה טלפונית יוצרת משתמש בלי אימייל, בלי שם
 * פרטי ומשפחה, בלי ת"ז ובלי סיסמה זמנית (הרשמת אתר דורשת אימייל; יצירת מנהל דורשת שם פרטי ומשפחה וסיסמה זמנית).
 * משתמש כזה לא יכול להתחבר לאתר (ההתחברות לפי אימייל), ולכן אין דרך שהשדה שונה אחרי היצירה.
 *
 * זה קריטריון מבני ולא הוכחה לכל שורה: לכן הכלי מריץ dry-run כברירת מחדל, ובפועל רץ רק באישור מפורש (ראו הסקריפט).
 * passwordHash לא נמחק ולא משתנה.
 */
const CANDIDATE_SQL = `
  "email" IS NULL AND "firstName" IS NULL AND "lastName" IS NULL AND "idNumber" IS NULL AND "gender" IS NULL
  AND "cardLast4" IS NULL AND "mustChangePassword" = false AND "role" = 'CLIENT'
  AND "phone" IS NOT NULL AND "ivrPinHash" IS NULL
`;

export interface LegacyMigrationResult {
  candidates: number;
  migrated: number;
}

export async function countLegacyPhonePinCandidates(db: PrismaClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "User" WHERE ${CANDIDATE_SQL}`);
  return Number(rows[0].n);
}

/** dry-run כברירת מחדל: סופר בלבד. apply=true מעתיק passwordHash -> ivrPinHash רק למועמדים, באטומיות, ורושם אירוע ביקורת */
export async function migrateLegacyPhonePins(db: PrismaClient, opts: { apply: boolean; now?: Date } = { apply: false }): Promise<LegacyMigrationResult> {
  const candidates = await countLegacyPhonePinCandidates(db);
  if (!opts.apply || candidates === 0) return { candidates, migrated: 0 };

  const now = opts.now ?? new Date();
  const migratedIds = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "User" SET "ivrPinHash" = "passwordHash", "ivrPinUpdatedAt" = $1 WHERE ${CANDIDATE_SQL} RETURNING "id"`,
      now
    );
    if (rows.length > 0) {
      await tx.ivrPinEvent.createMany({ data: rows.map((r) => ({ userId: r.id, kind: "MIGRATED_LEGACY" as const })) });
    }
    return rows.map((r) => r.id);
  });
  return { candidates, migrated: migratedIds.length };
}
