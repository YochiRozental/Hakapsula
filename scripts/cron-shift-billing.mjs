/**
 * הפעלת הריצה היומית של חיוב המשמרות (נקרא מ-Render Cron Job). אין כאן לוגיקה עסקית: רק קריאה מאומתת לנקודת הקצה
 * POST /api/cron/shift-billing ובדיקה שהריצה הצליחה. הלוגיקה עצמה אידמפוטנטית ונעולה בצד השרת (ריצה אחת בכל רגע, חיוב אחד
 * לכל מועד), ולכן ניסיון חוזר וגם הפעלה כפולה בטוחים.
 *
 * משתני סביבה: SITE_URL (כתובת האתר, ללא סלאש בסוף), CRON_SECRET (אותו סוד כמו בשירות האתר).
 *
 * קוד יציאה: 0 = הריצה הושלמה והצליחה (SUCCEEDED), או שריצה אחרת כבר רצה (ALREADY_RUNNING: מוגן, לא נכשל);
 *            1 = כל תוצאה אחרת (PARTIAL/FAILED, שגיאת HTTP, תשובה לא תקינה, חריגת זמן) — כדי ש-Render יסמן כישלון ויתריע.
 * הסוד לעולם אינו מודפס.
 */
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET ?? "";
const TIMEOUT_MS = Number(process.env.CRON_TIMEOUT_MS ?? 120_000);
const ATTEMPTS = 3;

if (!/^https?:\/\//.test(SITE_URL) || SECRET.length < 24) {
  console.error("[cron] חסרים או לא תקינים: SITE_URL (כתובת מלאה) ו-CRON_SECRET (לפחות 24 תווים)");
  process.exit(1);
}

async function callOnce() {
  const res = await fetch(`${SITE_URL}/api/cron/shift-billing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // תשובה שאינה JSON (למשל דף שגיאה): תטופל כשגיאה
  }
  return { status: res.status, body };
}

let last = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    last = await callOnce();
    // 4xx = תצורה שגויה (סוד/שער): ניסיון חוזר לא יעזור. 5xx/רשת: ננסה שוב (הריצה אידמפוטנטית)
    if (last.status < 500) break;
    console.error(`[cron] ניסיון ${attempt}: HTTP ${last.status}`);
  } catch (err) {
    last = null;
    console.error(`[cron] ניסיון ${attempt}: ${err instanceof Error ? err.name : "error"}`);
  }
  if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 5_000 * attempt));
}

if (!last) {
  console.error("[cron] הכישלון נמשך: אין תשובה מהשרת");
  process.exit(1);
}
const { status, body } = last;
if (status !== 200 || !body) {
  console.error(`[cron] נכשל: HTTP ${status}${status === 404 ? " (השער סגור או CRON_SECRET קצר/חסר בשרת)" : status === 401 ? " (סוד שגוי)" : ""}`);
  process.exit(1);
}
if (body.outcome === "ALREADY_RUNNING") {
  console.log("[cron] ריצה אחרת כבר פעילה (מוגן מהפעלה כפולה). אין צורך בפעולה");
  process.exit(0);
}
if (body.outcome === "DONE" && body.status === "SUCCEEDED") {
  console.log(`[cron] הצליח. runId=${body.runId} summary=${JSON.stringify(body.summary)}`);
  process.exit(0);
}
console.error(`[cron] הריצה לא הצליחה במלואה: outcome=${body.outcome} status=${body.status} runId=${body.runId} summary=${JSON.stringify(body.summary)}`);
process.exit(1);
