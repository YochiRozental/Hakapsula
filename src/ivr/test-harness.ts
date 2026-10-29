import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

/** כלי עזר לבדיקות פרוטוקול ה-IVR: שרת על פורט אקראי, שליחת בקשות GET/POST כמו ימות המשיח, ותפיסת לוגים */

export type Method = "GET" | "POST";

export interface RunningApp {
  base: string;
  close(): Promise<void>;
}

export async function startApp(app: Express): Promise<RunningApp> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface Reply {
  status: number;
  text: string;
}

/**
 * שולח בקשה כפי שימות המשיח שולחת: GET עם הפרמטרים ב-query, או POST (api_url_post=yes) עם urlencoded בגוף.
 * pairs: זוגות [שם, ערך] (מאפשר פרמטרים כפולים); extraQuery: פרמטרים ב-query של בקשת POST (לבדיקות עמימות)
 */
export async function send(
  base: string,
  path: string,
  method: Method,
  pairs: [string, string][],
  opts: { extraQuery?: [string, string][]; contentType?: string; rawBody?: string } = {}
): Promise<Reply> {
  const qs = (p: [string, string][]) => new URLSearchParams(p).toString();
  let url = base + path;
  let init: RequestInit;
  if (method === "GET") {
    url += "?" + qs(pairs);
    init = { method: "GET" };
  } else {
    if (opts.extraQuery?.length) url += "?" + qs(opts.extraQuery);
    init = {
      method: "POST",
      headers: { "content-type": opts.contentType ?? "application/x-www-form-urlencoded" },
      body: opts.rawBody ?? qs(pairs),
    };
  }
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text() };
}

/** שם הפרמטר שהספרייה מבקשת בקריאה הבאה (למשל val_1), מתוך תשובת read */
export function nextValName(reply: string): string | null {
  const m = reply.match(/=(val_\d+),/);
  return m ? m[1] : null;
}

/** תופס כל מה שנכתב ל-console בזמן הרצה, כדי לוודא שלא דלפו נתונים רגישים ללוגים */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  };
  console.log = grab;
  console.error = grab;
  console.warn = grab;
  console.info = grab;
  try {
    return { result: await fn(), output: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
