/**
 * העברת קודים טלפוניים ותיקים מ-passwordHash אל ivrPinHash (ראו src/lib/ivr-pin/legacy.ts לקריטריון ולהסתייגויות).
 *
 * שימוש:
 *   npx tsx scripts/migrate-legacy-ivr-pins.ts                      # dry-run: סופר בלבד
 *   npx tsx scripts/migrate-legacy-ivr-pins.ts --apply --confirm-host=<מארח המסד>
 *
 * בטיחות: ברירת המחדל מסרבת לרוץ מול מסד שאינו מקומי. מסד מרוחק (כולל Neon) דורש --allow-remote, ועל apply נדרש
 * בנוסף --confirm-host עם שם המארח המדויק, כדי שלא יורץ בטעות. אין להריץ על נתונים אמיתיים בלי אישור מפורש.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { migrateLegacyPhonePins } from "../src/lib/ivr-pin/legacy";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL לא מוגדר");
  process.exit(1);
}
const host = new URL(url).hostname;
const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

if (!isLocal && !flag("--allow-remote")) {
  console.error(`מסרב לרוץ מול מסד שאינו מקומי (${host}). נדרש --allow-remote ואישור מפורש.`);
  process.exit(2);
}
const apply = flag("--apply");
if (apply && option("--confirm-host") !== host) {
  console.error(`apply דורש --confirm-host=${host}`);
  process.exit(3);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
migrateLegacyPhonePins(prisma, { apply })
  .then((r) => {
    console.log(`[${apply ? "APPLY" : "DRY-RUN"}] host=${host} candidates=${r.candidates} migrated=${r.migrated}`);
  })
  .catch((e) => {
    console.error("נכשל:", e instanceof Error ? e.name : "error");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
