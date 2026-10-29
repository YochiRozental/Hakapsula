/**
 * הרצה ידנית של החיוב החודשי למשמרות בסביבת פיתוח (אותה פונקציה שה-Cron מריץ; אידמפוטנטית).
 *
 *   npx tsx scripts/run-shift-billing.ts            # עכשיו
 *   npx tsx scripts/run-shift-billing.ts --at=2027-03-01T05:00:00Z   # כאילו הרגע הוא כך (לבדיקות)
 *
 * בטיחות: מסרב לרוץ מול מסד שאינו מקומי, ורק כשהשער פתוח (SHIFTS_ENABLED=true וספק Mock תקף בסביבת sandbox). אין כאן
 * חיוב אמיתי: בסביבה חיה אין ספק תקף ולכן הסקריפט פשוט מסרב.
 */
import "dotenv/config";
import { runMonthlyShiftBilling } from "../src/lib/shifts/billing";
import { getShiftsProvider } from "../src/lib/shifts/gate";
import { prisma } from "../src/lib/prisma";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL לא מוגדר");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error(`מסרב לרוץ מול מסד שאינו מקומי (${host})`);
  process.exit(2);
}
const provider = getShiftsProvider();
if (!provider) {
  console.error("השער סגור: נדרשים SHIFTS_ENABLED=true וספק Mock תקף בסביבת sandbox מקומית");
  process.exit(3);
}
const at = process.argv.find((a) => a.startsWith("--at="))?.slice(5);
const now = at ? new Date(at) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error("--at לא תקין");
  process.exit(4);
}

runMonthlyShiftBilling({ provider, trigger: "script", now })
  .then((r) => console.log(r.outcome === "DONE" ? `[${r.status}] ${JSON.stringify(r.summary)}` : "[ALREADY_RUNNING]"))
  .catch((e) => {
    console.error("נכשל:", e instanceof Error ? e.name : "error");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
