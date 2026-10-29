import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runMonthlyShiftBilling } from "@/lib/shifts/billing";
import { gateProvider } from "@/lib/shifts/http";

/**
 * נקודת הכניסה לריצה מתוזמנת של החיוב החודשי (מיועדת ל-Render Cron עתידי, מדי יום בשעה קבועה; ההרצה אידמפוטנטית ולכן
 * חוזרת/כפולה בטוחה). לא נוצר שום Cron חי. מוגנת בסוד נפרד (CRON_SECRET, לפחות 24 תווים) שנשלח ב-Authorization: Bearer,
 * ומושווה בזמן קבוע. בלי שער פתוח (ספק Mock בסביבת sandbox מקומית) או בלי סוד מוגדר: 404, כאילו אינה קיימת. בסביבה חיה
 * אין ספק תקף ולכן אין חיוב אוטומטי.
 */
const MIN_SECRET_LENGTH = 24;

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const provider = gateProvider();
  const secret = process.env.CRON_SECRET;
  if (!provider || !secret || secret.length < MIN_SECRET_LENGTH) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // השוואת hash בזמן קבוע: גם אורך הסוד אינו נחשף
  if (!timingSafeEqual(digest(presented), digest(secret))) return NextResponse.json({ error: "אין הרשאה" }, { status: 401 });

  try {
    return NextResponse.json(await runMonthlyShiftBilling({ provider, trigger: "cron" }));
  } catch (err) {
    console.error("[cron] shift billing failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "הריצה נכשלה" }, { status: 500 });
  }
}
