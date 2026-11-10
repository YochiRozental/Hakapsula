/**
 * מחליף את ארבע משבצות המשמרת הפעילות במחירון החדש (ראו דוח הסנכרון): יוצר 4 משבצות חדשות ומשבית את הישנות
 * (MORNING/NOON/AFTERNOON/EVENING) — ללא עריכה במקום, כך שמשמרות קיימות (אם יהיו) ממשיכות להצביע על ההגדרה
 * הישנה והקפואה שלהן (ראו saveShiftWindows ב-src/lib/shifts/windows-db.ts: עריכה משפיעה רק על הזמנות חדשות
 * ועל שינויים מאושרים; מופעים וחיובים קיימים אינם מחושבים מחדש).
 *
 * ברירת מחדל: יבש (dry-run) — מדפיס מה ישתנה ויוצא, בלי לכתוב למסד.
 * כתיבה בפועל: npx tsx scripts/sync-shift-windows-2026.ts --apply --admin-id=<מזהה מנהל אמיתי>
 * מסרב לרוץ מול מסד מרוחק (לפי DATABASE_URL) אלא אם הועבר גם --allow-remote במפורש — בחירה מודעת, לא ברירת מחדל.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { listShiftWindows, saveShiftWindows } from "../src/lib/shifts/windows-db";
import type { WindowInput } from "../src/lib/shifts/windows";

const NEW_WINDOWS: Omit<WindowInput, "id">[] = [
  { name: "בוקר", startMinutes: 8 * 60 + 45, endMinutes: 12 * 60 + 45, monthlyPriceShekel: 480, active: true },
  { name: "צהריים", startMinutes: 13 * 60, endMinutes: 16 * 60, monthlyPriceShekel: 480, active: true },
  { name: "אחר הצהריים", startMinutes: 16 * 60 + 15, endMinutes: 20 * 60, monthlyPriceShekel: 460, active: true },
  { name: "ערב", startMinutes: 20 * 60 + 15, endMinutes: 24 * 60, monthlyPriceShekel: 500, active: true },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const allowRemote = process.argv.includes("--allow-remote");
  const adminId = process.argv.find((a) => a.startsWith("--admin-id="))?.slice("--admin-id=".length);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL לא מוגדר");
  const host = new URL(url).hostname;
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!isLocal && !allowRemote) {
    console.error(`מסרב לרוץ מול מסד מרוחק (${host}) בלי --allow-remote מפורש. הריצה היבשה (ללא --apply) בטוחה בכל מסד.`);
    process.exitCode = 2;
    return;
  }

  const before = await listShiftWindows();
  console.log("משבצות פעילות כעת:");
  for (const w of before.filter((w) => w.active)) {
    console.log(`  [${w.id}] ${w.name} ${String(Math.floor(w.startMinutes / 60)).padStart(2, "0")}:${String(w.startMinutes % 60).padStart(2, "0")}–${String(Math.floor(w.endMinutes / 60)).padStart(2, "0")}:${String(w.endMinutes % 60).padStart(2, "0")} — ${w.monthlyPriceAgorot / 100} ₪`);
  }
  console.log("\nיוצר (משבצות חדשות, מזהה אוטומטי) ומשבית את כל הפעילות הקודמות שברשימה למעלה:");
  for (const w of NEW_WINDOWS) {
    console.log(`  [חדש] ${w.name} ${String(Math.floor(w.startMinutes / 60)).padStart(2, "0")}:${String(w.startMinutes % 60).padStart(2, "0")}–${String(Math.floor(w.endMinutes / 60)).padStart(2, "0")}:${String(w.endMinutes % 60).padStart(2, "0")} — ${w.monthlyPriceShekel} ₪`);
  }

  if (!apply) {
    console.log("\n(ריצה יבשה — לא נכתב דבר. הוסיפו --apply --admin-id=<מזהה מנהל> כדי לבצע בפועל.)");
    return;
  }
  if (!adminId) throw new Error("--apply דורש גם --admin-id=<מזהה מנהל אמיתי>");
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { role: true } });
  if (admin?.role !== "ADMIN") throw new Error("המזהה שהועבר אינו מנהל קיים");

  const openShifts = await prisma.shift.count({ where: { status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } } });
  console.log(`\nמשמרות פעילות/ממתינות כרגע שאינן מושפעות (ממשיכות על ההגדרה הישנה הקפואה): ${openShifts}`);

  const after = await saveShiftWindows({ adminId, windows: NEW_WINDOWS });
  console.log("\nבוצע. משבצות פעילות אחרי השינוי:");
  for (const w of after.filter((w) => w.active)) console.log(`  [${w.id}] ${w.name} — ${w.monthlyPriceAgorot / 100} ₪`);
}

main()
  .catch((e) => {
    console.error("נכשל:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
