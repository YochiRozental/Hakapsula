#!/usr/bin/env node
/**
 * בדיקת עשן HTTP מול שרת ההדגמה המקומי (localhost בלבד): הרשאות, דגלים, CSRF, ויומן הביקורת בנתיב הישן.
 *   node scripts/demo/smoke.mjs          # דגלים פתוחים (ברירת המחדל של npm run demo)
 *   node scripts/demo/smoke.mjs closed   # מול שרת שהופעל עם DEMO_FLAGS=closed
 * קורא את החשבונות מ-.demo/credentials.json. הבדיקה משנה זמנית סטטוס של לקוח ההדגמה "tester" וחוזרת אליו.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = process.env.DEMO_BASE ?? "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("רק localhost");
const MODE = process.argv[2] === "closed" ? "closed" : "open";
const creds = Object.fromEntries(JSON.parse(readFileSync(join(root, ".demo", "credentials.json"), "utf8")).map((c) => [c.email.split("@")[0], c]));

class Client {
  jar = new Map();
  async req(path, init = {}) {
    const headers = { ...(init.headers ?? {}), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers["content-type"] = "application/json";
    }
    const method = init.method ?? (body ? "POST" : "GET");
    if (method !== "GET" && init.sameOrigin !== false) headers.origin = BASE;
    const res = await fetch(BASE + path, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  async json(path, init) {
    const res = await this.req(path, init);
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  async login(user) {
    const csrf = await (await this.req("/api/auth/csrf")).json();
    await this.req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: creds[user].email, password: creds[user].password, json: "true" }).toString(),
    });
    assert.equal((await (await this.req("/api/auth/session")).json())?.user?.email, creds[user].email, "login " + user);
  }
}

let passed = 0;
const failed = [];
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✔", name);
  } catch (e) {
    failed.push(name);
    console.log("  ✖", name, "\n     ", String(e.message).split("\n")[0]);
  }
};

const anon = new Client();
const admin = new Client();
const client = new Client();
await admin.login("admin");
await client.login("dan");

console.log(`smoke (${MODE}) · ${BASE}`);
await t("ספק התשלומים הוא Mock בסביבת sandbox (אין חיוב אמיתי)", async () => {
  const r = await client.json("/api/payments/status");
  assert.equal(r.status, 200);
  assert.equal(r.data.sandbox, true);
});
await t("דף הבית נטען", async () => assert.equal((await anon.req("/")).status, 200));

if (MODE === "closed") {
  for (const p of ["/api/admin/finance/overview", "/api/admin/finance/audit", "/api/shifts", "/api/admin/shifts"]) {
    await t(`דגל סגור: ${p} -> 404`, async () => assert.equal((p.includes("admin") ? admin : client).req ? (await (p.includes("admin") ? admin : client).req(p)).status : 0, 404));
  }
  for (const p of ["/admin/finance", "/admin/shifts"]) await t(`דגל סגור: ${p} -> 404`, async () => assert.equal((await admin.req(p)).status, 404));
  await t("דגל סגור: /profile/shifts -> 404; אין קישור משמרות בפרופיל", async () => {
    assert.equal((await client.req("/profile/shifts")).status, 404);
    assert.ok(!(await (await client.req("/profile")).text()).includes("/profile/shifts"));
  });
  await t("דגל סגור: חבילות וקביעת תור עדיין עובדים", async () => {
    assert.equal((await client.req("/profile/hours")).status, 200);
    assert.equal((await client.req("/booking")).status, 200);
  });
} else {
  await t("עמודי לקוח נטענים (תורים, כרטיס, חבילות, קוד IVR, כרטיס שמור, משמרות)", async () => {
    for (const p of ["/booking", "/booking/my", "/profile", "/profile/hours", "/profile/ivr-pin", "/profile/payment-method", "/profile/shifts"]) assert.equal((await client.req(p)).status, 200, p);
  });
  await t("עמודי מנהל נטענים (ניהול כספי, משמרות)", async () => {
    for (const p of ["/admin", "/admin/finance", "/admin/shifts"]) assert.equal((await admin.req(p)).status, 200, p);
  });
  await t("הרשאות: לא מחובר 401, לקוח 403 בנתיבי ניהול כספי ומשמרות", async () => {
    for (const p of ["/api/admin/finance/overview", "/api/admin/finance/debts", "/api/admin/shifts"]) {
      assert.equal((await anon.json(p)).status, 401, p);
      assert.equal((await client.json(p)).status, 403, p);
    }
    assert.equal((await client.json("/api/admin/finance/refunds", { json: {} })).status, 403);
  });
  await t("CSRF: כתיבת מנהל בלי origin נדחית", async () => {
    assert.equal((await admin.json("/api/admin/finance/debts/x/waive", { json: {}, sameOrigin: false })).status, 403);
  });
  await t("תמונת מצב כספית נטענת עם סכומים בשלמים", async () => {
    const r = await admin.json("/api/admin/finance/overview");
    assert.equal(r.status, 200);
    assert.ok(Number.isInteger(r.data.collected.grossAgorot));
    assert.ok(Number.isInteger(r.data.outstandingNotCollectedAgorot));
  });
  await t("יומן ביקורת: חסימה/שחרור דרך נתיב המשתמשים הישן נרשמים פעם אחת, בלי כפילות בשליחה חוזרת", async () => {
    const found = await admin.json("/api/admin/finance/customers?q=לקוח לניסוי");
    const id = found.data.customers[0].id;
    const count = async (action) => (await admin.json(`/api/admin/finance/audit?userId=${id}&action=${action}&take=300`)).data.entries.length;
    const b0 = await count("CUSTOMER_BLOCKED");
    const u0 = await count("CUSTOMER_UNBLOCKED");
    const patch = (status) => admin.json(`/api/admin/users/${id}`, { method: "PATCH", json: { status } });
    assert.equal((await patch("BLOCKED")).status, 200);
    assert.equal((await patch("BLOCKED")).status, 200); // שליחה חוזרת: אין שינוי, אין רשומה
    assert.equal(await count("CUSTOMER_BLOCKED"), b0 + 1);
    const entry = (await admin.json(`/api/admin/finance/audit?userId=${id}&action=CUSTOMER_BLOCKED&take=1`)).data.entries[0];
    assert.equal(entry.outcome, "ok");
    assert.ok(entry.adminName);
    assert.equal((await patch("APPROVED")).status, 200);
    assert.equal((await patch("APPROVED")).status, 200);
    assert.equal(await count("CUSTOMER_UNBLOCKED"), u0 + 1);
  });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
