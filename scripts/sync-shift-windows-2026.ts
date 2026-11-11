/**
 * מחליף את ארבע משבצות המשמרת הפעילות במחירון החדש (ראו דוח הסנכרון): יוצר 4 משבצות חדשות ומשבית את הישנות
 * (MORNING/NOON/AFTERNOON/EVENING) — ללא עריכה במקום, כך שמשמרות קיימות (אם יהיו) ממשיכות להצביע על ההגדרה
 * הישנה והקפואה שלהן (ראו saveShiftWindows ב-src/lib/shifts/windows-db.ts: עריכה משפיעה רק על הזמנות חדשות
 * ועל שינויים מאושרים; מופעים וחיובים קיימים אינם מחושבים מחדש). הכתיבה עצמה אטומית (saveShiftWindows רץ
 * בטרנזקציית DB אחת) ונרשמת ביומן הביקורת כרגיל.
 *
 * אידמפוטנטי: לפני כל כתיבה (או הדפסת dry-run) הסקריפט בודק את המצב הקיים לפי שעות+מחיר (ראו determineState):
 *  - אם 4 המשבצות החדשות כבר קיימות ופעילות וה-4 הישנות כבר לא פעילות — הסנכרון כבר בוצע: לא נכתב דבר, exit 0.
 *  - אם המצב חלקי/לא צפוי (למשל רק חלק מהחדשות נוצרו, או כפילות) — עוצר בלי לכתוב, exit 1.
 *  - רק כשהמצב "טרי" (4 הישנות פעילות, אף חדשה לא קיימת) — ממשיך לכתיבה.
 *
 * ברירת מחדל: יבש (dry-run) — מדפיס מה ישתנה (או שהסנכרון כבר בוצע) ויוצא, בלי לכתוב למסד.
 * כתיבה בפועל: npx tsx scripts/sync-shift-windows-2026.ts --apply --admin-id=<מזהה מנהל אמיתי>
 * מסרב לרוץ מול מסד מרוחק (לפי DATABASE_URL) אלא אם הועבר גם --allow-remote במפורש — בחירה מודעת, לא ברירת מחדל.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { listShiftWindows, saveShiftWindows } from "../src/lib/shifts/windows-db";
import type { ShiftWindowDef, WindowInput } from "../src/lib/shifts/windows";

const OLD_WINDOW_IDS = ["MORNING", "NOON", "AFTERNOON", "EVENING"] as const;

const NEW_WINDOWS: Omit<WindowInput, "id">[] = [
  { name: "בוקר", startMinutes: 8 * 60 + 45, endMinutes: 12 * 60 + 45, monthlyPriceShekel: 480, active: true },
  { name: "צהריים", startMinutes: 13 * 60, endMinutes: 16 * 60, monthlyPriceShekel: 480, active: true },
  { name: "אחר הצהריים", startMinutes: 16 * 60 + 15, endMinutes: 20 * 60, monthlyPriceShekel: 460, active: true },
  { name: "ערב", startMinutes: 20 * 60 + 15, endMinutes: 24 * 60, monthlyPriceShekel: 500, active: true },
];

const fmtHours = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtWindow = (w: { name: string; startMinutes: number; endMinutes: number; monthlyPriceAgorot: number }) =>
  `${w.name} ${fmtHours(w.startMinutes)}–${fmtHours(w.endMinutes)} — ${w.monthlyPriceAgorot / 100} ₪`;

function matchesNewSpec(w: ShiftWindowDef, spec: Omit<WindowInput, "id">): boolean {
  return w.active && w.startMinutes === spec.startMinutes && w.endMinutes === spec.endMinutes && w.monthlyPriceAgorot === spec.monthlyPriceShekel * 100;
}

type SyncState = { kind: "already_synced" } | { kind: "ready_to_apply" } | { kind: "unexpected"; reason: string };

/** קובע לפי המצב הקיים האם הסנכרון כבר בוצע, טרי ומוכן, או חלקי/לא צפוי (ואז אין לכתוב דבר) */
function determineState(current: ShiftWindowDef[]): SyncState {
  const matchesPerSpec = NEW_WINDOWS.map((spec) => current.filter((w) => matchesNewSpec(w, spec)));
  if (matchesPerSpec.some((m) => m.length > 1)) {
    return { kind: "unexpected", reason: "כמה משבצות פעילות תואמות לאותה הגדרה חדשה בו-זמנית (כפילות) — נדרשת בדיקה ידנית" };
  }
  const allNewPresent = matchesPerSpec.every((m) => m.length === 1);
  const anyNewPresent = matchesPerSpec.some((m) => m.length === 1);
  const oldActive = OLD_WINDOW_IDS.filter((id) => current.some((w) => w.id === id && w.active));

  if (allNewPresent) {
    if (oldActive.length === 0) return { kind: "already_synced" };
    return { kind: "unexpected", reason: `המשבצות החדשות כבר קיימות ופעילות, אך המשבצות הישנות הבאות עדיין פעילות: ${oldActive.join(", ")}` };
  }
  if (anyNewPresent) {
    return { kind: "unexpected", reason: "חלק מהמשבצות החדשות קיימות וחלק לא — מצב ביניים (אולי ריצה קודמת נקטעה בחצי הדרך)" };
  }
  const missingOrInactive = OLD_WINDOW_IDS.filter((id) => !current.some((w) => w.id === id && w.active));
  if (missingOrInactive.length > 0) {
    return { kind: "unexpected", reason: `אף משבצת חדשה לא נוצרה עדיין, אך המשבצות הישנות הבאות אינן פעילות/קיימות כצפוי: ${missingOrInactive.join(", ")}` };
  }
  return { kind: "ready_to_apply" };
}

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
  console.log("משבצות קיימות כעת (פעילות ולא-פעילות):");
  for (const w of before) console.log(`  [${w.id}]${w.active ? "" : " (מושבתת)"} ${fmtWindow(w)}`);

  const state = determineState(before);

  if (state.kind === "unexpected") {
    console.error(`\nעוצר ללא שום שינוי — מצב לא צפוי/חלקי: ${state.reason}`);
    process.exitCode = 1;
    return;
  }

  if (state.kind === "already_synced") {
    console.log("\nהסנכרון כבר בוצע בעבר: 4 המשבצות החדשות פעילות וה-4 הישנות מושבתות. לא בוצע ולא יבוצע שום שינוי (אידמפוטנטי).");
    return;
  }

  // state.kind === "ready_to_apply": המצב טרי — 4 הישנות פעילות, אף חדשה לא קיימת
  console.log("\nיוצר (משבצות חדשות, מזהה אוטומטי) ומשבית את ארבעת הישנות שלמעלה:");
  for (const w of NEW_WINDOWS) console.log(`  [חדש] ${w.name} ${fmtHours(w.startMinutes)}–${fmtHours(w.endMinutes)} — ${w.monthlyPriceShekel} ₪`);

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
  for (const w of after.filter((w) => w.active)) console.log(`  [${w.id}] ${fmtWindow(w)}`);

  const postState = determineState(after);
  if (postState.kind !== "already_synced") {
    console.error("\nאזהרה: המצב אחרי הכתיבה אינו תואם למצב 'מסונכרן' הצפוי — נדרשת בדיקה ידנית.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("נכשל:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
