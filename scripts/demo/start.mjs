#!/usr/bin/env node
/**
 * סביבת הדגמה מקומית אחת: מסד PostgreSQL ייעודי (clinics_demo, localhost בלבד), מיגרציות, נתוני הדגמה, שרת Next.js,
 * כל דגלי שלבים A-H פתוחים וספק תשלומים Mock. אינו נוגע ב-.env (שמצביע על מסד מרוחק), ב-Neon, ב-Render או בימות המשיח:
 * הגדרות ההדגמה מועברות כמשתני סביבה לתהליך השרת בלבד (הם גוברים על .env), וסודות נוצרים אקראית ל-.demo/ (מחוץ ל-Git).
 *
 *   npm run demo          # מפעיל (ויוצר מסד ונתונים בפעם הראשונה)
 *   npm run demo:reset    # מוחק רק את מסד ההדגמה clinics_demo ויוצר אותו מחדש
 *   npm run demo -- --check   # בדיקת מוכנות בלבד (בלי להפעיל שרת)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const demoDir = join(root, ".demo");
const secretsFile = join(demoDir, "secrets.json");
const credsFile = join(demoDir, "credentials.json");
const PORT = Number(process.env.DEMO_PORT ?? 3100);
const DB_NAME = "clinics_demo";
const ADMIN_URL = process.env.DEMO_PG_ADMIN_URL ?? "postgresql://clinics:clinics_dev_password@localhost:5433/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);
const args = new Set(process.argv.slice(2));

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// בטיחות: רק localhost
for (const u of [ADMIN_URL, DB_URL]) {
  const host = new URL(u).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) fail(`מסרב: מסד לא מקומי (${host})`);
}

mkdirSync(demoDir, { recursive: true });
const secrets = existsSync(secretsFile)
  ? JSON.parse(readFileSync(secretsFile, "utf8"))
  : (() => {
      const s = { AUTH_SECRET: randomBytes(32).toString("base64url"), PAYMENT_WEBHOOK_SECRET: randomBytes(24).toString("base64url"), CRON_SECRET: randomBytes(24).toString("base64url") };
      writeFileSync(secretsFile, JSON.stringify(s, null, 2));
      return s;
    })();

const env = {
  ...process.env,
  DATABASE_URL: DB_URL,
  AUTH_SECRET: secrets.AUTH_SECRET,
  NEXTAUTH_URL: `http://localhost:${PORT}`,
  AUTH_URL: `http://localhost:${PORT}`,
  AUTH_TRUST_HOST: "true",
  // ספק תשלומים Mock בלבד
  PAYMENT_PROVIDER: "mock",
  PAYMENT_ENVIRONMENT: "sandbox",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_WEBHOOK_SECRET: secrets.PAYMENT_WEBHOOK_SECRET,
  CRON_SECRET: secrets.CRON_SECRET,
  // כל הדגלים של שלבים A-H: פתוחים להדגמה מקומית בלבד
  // DEMO_FLAGS=closed: כל דגלי השלבים החדשים סגורים (לבדיקת התנהגות ברירת המחדל), הספק נשאר Mock
  ...(process.env.DEMO_FLAGS === "closed"
    ? { MOCK_SAVED_CARD_ENABLED: "false", IVR_PIN_SETUP_ENABLED: "false", IVR_PAYMENTS_ENABLED: "false", SHIFTS_ENABLED: "false", FINANCE_ADMIN_ENABLED: "false" }
    : { MOCK_SAVED_CARD_ENABLED: "true", IVR_PIN_SETUP_ENABLED: "true", IVR_PAYMENTS_ENABLED: "true", SHIFTS_ENABLED: "true", FINANCE_ADMIN_ENABLED: "true" }),
  // לא שולחים דוא"ל אמיתי מההדגמה (ה-.env עשוי להכיל הגדרות SMTP)
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  NODE_ENV: "development",
};

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });

async function ensureDatabase() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    fail("אי אפשר להתחבר ל-PostgreSQL המקומי (localhost:5433). הפעילו קודם: docker compose up -d");
  }
  if (args.has("--reset")) {
    // מוחק רק את מסד ההדגמה בשמו המדויק
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [DB_NAME]);
    await admin.query(`drop database if exists ${DB_NAME}`);
    console.log("• מסד ההדגמה נמחק");
  }
  const exists = (await admin.query("select 1 from pg_database where datname = $1", [DB_NAME])).rowCount > 0;
  if (!exists) await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  return !exists;
}

function run(cmd, cmdArgs, label) {
  const res = spawnSync(cmd, cmdArgs, { cwd: root, env, stdio: "pipe", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(String(res.stdout ?? "").slice(-1500), String(res.stderr ?? "").slice(-1500));
    fail(`${label} נכשל`);
  }
}

async function main() {
  console.log(`\nסביבת הדגמה מקומית · מסד ${DB_NAME} · פורט ${PORT}`);
  const created = await ensureDatabase();
  console.log(created ? "• נוצר מסד הדגמה חדש" : "• מסד ההדגמה קיים");
  run("npx", ["prisma", "migrate", "deploy"], "הרצת מיגרציות");
  console.log("• מיגרציות עודכנו");
  const seeded = spawnSync("npx", ["tsx", "scripts/demo/seed.ts"], { cwd: root, env: { ...env, DEMO_PASSWORDS_FILE: credsFile }, stdio: "inherit", shell: process.platform === "win32" });
  if (seeded.status !== 0) fail("יצירת נתוני ההדגמה נכשלה");

  if (args.has("--check")) {
    console.log("• בדיקת מוכנות עברה (מסד, מיגרציות, נתונים). לא הופעל שרת");
    return;
  }
  if (!(await portFree(PORT))) fail(`פורט ${PORT} תפוס. אם זה שרת ההדגמה הקודם, הוא כבר רץ: http://localhost:${PORT}`);

  const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: root, env, stdio: "inherit" });
  server.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill());

  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`, { redirect: "manual" });
      if (r.status < 500) break;
    } catch {}
    if (Date.now() > deadline) fail("השרת לא עלה תוך 2 דקות");
    await new Promise((r) => setTimeout(r, 1500));
  }

  const creds = existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, "utf8")) : [];
  console.log(`\n✔ מוכן: http://localhost:${PORT}   (מאזין ב-127.0.0.1 בלבד, לא חשוף לרשת)`);
  console.log(`\nחשבונות הדגמה (סיסמאות אקראיות, נשמרות רק ב-${join(".demo", "credentials.json")} שאינו נכנס ל-Git):`);
  for (const c of creds) console.log(`  ${c.email.padEnd(20)} ${c.password.padEnd(14)} ${c.label}`);
  console.log("\nלעצירה: Ctrl+C\n");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
