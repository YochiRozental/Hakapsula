import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isIvrPinSetupEnabled } from "@/lib/ivr-pin/flag";
import { setIvrPin } from "@/lib/ivr-pin/service";
import { isJsonRequest, isSameOriginRequest } from "@/lib/same-origin";

/**
 * הגדרת קוד טלפוני באתר. מחזיר רק האם קוד מוגדר ומתי עודכן: לעולם לא את הקוד ולא את ה-hash.
 * סגור (404) כל עוד IVR_PIN_SETUP_ENABLED אינו true.
 */
export async function GET() {
  if (!isIvrPinSetupEnabled()) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { ivrPinHash: true, ivrPinUpdatedAt: true } });
  if (!user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  return NextResponse.json({ hasPin: !!user.ivrPinHash, updatedAt: user.ivrPinUpdatedAt });
}

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  pin: z.string().max(16),
  pinConfirm: z.string().max(16),
});

export async function POST(request: Request) {
  if (!isIvrPinSetupEnabled()) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
  // הגנת CSRF: אותו מקור + JSON בלבד, בנוסף לעוגיית ה-Session
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "בקשה לא מורשית" }, { status: 403 });
  if (!isJsonRequest(request)) return NextResponse.json({ error: "פורמט בקשה לא נתמך" }, { status: 415 });

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "נתונים לא תקינים" }, { status: 400 });

  try {
    const result = await setIvrPin({ userId: session.user.id, ...parsed.data });
    switch (result.status) {
      case "OK":
        // בכוונה בלי הקוד ובלי hash בתגובה
        return NextResponse.json({ ok: true, replaced: result.replaced });
      case "INVALID_PIN":
        return NextResponse.json({ error: "הקוד חייב להכיל ארבע ספרות בדיוק" }, { status: 400 });
      case "PIN_MISMATCH":
        return NextResponse.json({ error: "הקודים שהוקלדו אינם זהים" }, { status: 400 });
      case "INVALID_PASSWORD":
        return NextResponse.json({ error: "הסיסמה שגויה", attemptsLeft: result.attemptsLeft }, { status: 400 });
      case "BLOCKED":
        return NextResponse.json(
          { error: "בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר", retryAfterSeconds: result.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
        );
      case "NOT_ALLOWED":
        return NextResponse.json({ error: "לא ניתן להגדיר קוד בחשבון זה כרגע" }, { status: 403 });
    }
  } catch (err) {
    // לא רושמים הודעת שגיאה: היא עלולה להכיל נתוני בקשה
    console.error("[ivr-pin] set failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "שגיאה בשמירת הקוד" }, { status: 500 });
  }
}
