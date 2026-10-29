import express from "express";
import type { NextFunction, Request, Response } from "express";
import { YemotRouter } from "yemot-router2";
import type { Call } from "yemot-router2";

/**
 * בניית אפליקציית ה-IVR: נתב ימות המשיח + הקשחת בקשות + לוגים בטוחים. נפרד מ-server.ts כדי שאפשר יהיה לבדוק
 * את הפרוטוקול (GET ו-POST) מול בקשות HTTP אמיתיות בלי להאזין לפורט קבוע.
 */

export type IvrHandler = (call: Call) => Promise<unknown>;

export interface IvrHandlers {
  check: IvrHandler;
  members: IvrHandler;
  notRegistered: IvrHandler;
}

/** גודל גוף POST מרבי. בקשות ימות המשיח קטנות (עשרות פרמטרים קצרים) */
const MAX_BODY = "8kb";
const MAX_PARAMS = 100;

/** גוף POST נתמך: application/x-www-form-urlencoded בלבד (הפורמט ש-api_url_post=yes של ימות המשיח שולח) */
const SUPPORTED_POST_TYPE = "application/x-www-form-urlencoded";

function reject(res: Response, status: number) {
  // תשובה קבועה: לא מחזירים ולא רושמים שום חלק מהבקשה
  res.status(status).json({ message: "invalid request" });
}

/**
 * הקשחת POST לפני הנתב:
 *  - פורמט גוף אחר מ-urlencoded נדחה (415)
 *  - פרמטר שמופיע יותר מפעם אחת בגוף נדחה (הספרייה הייתה בוחרת בשקט את האחרון)
 *  - ערך ב-query שסותר ערך באותו שם בגוף נדחה: בבקשת POST הספרייה קוראת את הגוף בלבד, ולכן ערכי GET לעולם לא
 *    מחליפים ערכי POST, אבל בקשה עמומה כזו אינה לגיטימית ולכן נדחית במפורש
 * בקשות GET עוברות ללא שינוי.
 */
export function ivrRequestGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  if (!req.is(SUPPORTED_POST_TYPE)) return reject(res, 415);

  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const value of Object.values(body)) {
    if (typeof value !== "string") return reject(res, 400);
  }
  for (const [key, value] of Object.entries(req.query)) {
    if (Object.hasOwn(body, key) && body[key] !== value) return reject(res, 400);
  }
  next();
}

/** מטפל שגיאות אחרון: תשובה קבועה, והלוג כולל רק סוג וסטטוס — לעולם לא הודעת שגיאה, גוף או פרמטרים */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express מזהה מטפל שגיאות לפי ארבעה פרמטרים
function safeErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as { status?: unknown; type?: unknown; name?: unknown };
  const status = typeof e?.status === "number" && e.status >= 400 && e.status < 500 ? e.status : 500;
  const kind = typeof e?.type === "string" ? e.type : typeof e?.name === "string" ? e.name : "error";
  console.error(`[ivr] request rejected status=${status} kind=${kind}`);
  if (!res.headersSent) reject(res, status);
}

/** שם הסוג/הקוד של שגיאה בלבד. ההודעה והמחסנית לא נרשמות: הן עלולות להכיל טלפון, פרמטרים של שאילתה או שם */
function errorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const e = error as { name?: unknown; code?: unknown };
  const name = typeof e.name === "string" ? e.name : "Error";
  return typeof e.code === "string" ? `${name}/${e.code}` : name;
}

export function createIvrApp(params: { secret: string; handlers: IvrHandlers }) {
  const { secret, handlers } = params;

  const router = YemotRouter({
    // printLog של הספרייה רושם את מספר הטלפון של המתקשר (ApiPhone) ולכן כבוי. הלוגים התפעוליים הרלוונטיים
    // (שיחה חדשה, ניתוק, שגיאה) נרשמים כאן בלי נתונים אישיים
    printLog: false,
    defaults: {
      removeInvalidChars: true,
    },
    uncaughtErrorHandler: (error, call) => {
      console.error(`[ivr] uncaught error for call ${call.callId}: ${errorKind(error)}`);
      // נשאר טקסט (ולא קובץ מוקלט) בכוונה: זו נפילת חירום גלובלית שיכולה לקרות בכל שלוחה,
      // ואין שלוחת-בית אחת שבה אפשר להקליט לה קובץ.
      // בלי נקודה בטקסט: הספרייה דוחה תווים כמו "." בהקראה, והמטפל עצמו היה נכשל ומפיל את התהליך (באג שהיה קיים)
      return call.id_list_message([
        { type: "text", data: "אירעה שגיאה במערכת, אנא נסו שוב מאוחר יותר תודה ולהתראות", removeInvalidChars: true },
      ]);
    },
  });

  router.events.on("new_call", (call) => {
    // בכוונה בלי מספר הטלפון של המתקשר בלוג
    console.log(`[ivr] new call ${call.callId} extension=${call.extension}`);
  });
  router.events.on("call_hangup", (call) => {
    console.log(`[ivr] call ${call.callId} hung up`);
  });

  // אותה לוגיקה בדיוק לשתי השיטות: GET (כפי שהיה) ו-POST (api_url_post=yes של ימות המשיח)
  const routes: [string, IvrHandler][] = [
    [`/check-${secret}`, handlers.check],
    [`/booking-${secret}`, handlers.members],
    [`/not-registered-${secret}`, handlers.notRegistered],
  ];
  for (const [path, handler] of routes) {
    router.get(path, handler);
    router.post(path, handler);
  }

  const app = express();
  // extended:false = ניתוח שטוח בלבד (בלי אובייקטים מקוננים), עם הגבלת גודל ומספר פרמטרים
  app.use(express.urlencoded({ extended: false, limit: MAX_BODY, parameterLimit: MAX_PARAMS }));
  app.use(ivrRequestGuard);
  app.use(router.asExpressRouter);
  app.use(safeErrorHandler);
  return app;
}
