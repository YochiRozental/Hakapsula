import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getFlowProvider } from "@/lib/payments/flow";
import { isMockCardEnabled } from "@/lib/payments/mock-card-flag";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { addMockCard, listPaymentMethods } from "@/lib/payments/saved-methods";
import { isJsonRequest, isSameOriginRequest } from "@/lib/same-origin";

/** הנתיב קיים רק כשהדגל פתוח וגם הספק הוא Mock בסביבת sandbox; בכל מצב אחר 404 */
function gate() {
  const provider = getFlowProvider();
  if (!isMockCardEnabled() || !(provider instanceof MockPaymentProvider)) return null;
  return provider;
}
const notFound = () => NextResponse.json({ error: "לא נמצא" }, { status: 404 });

/** אמצעי התשלום השמורים של המשתמש המחובר, בתצוגה מוסתרת בלבד (4 ספרות, מותג, תוקף). לעולם לא טוקן */
export async function GET() {
  if (!gate()) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  return NextResponse.json({ methods: await listPaymentMethods(session.user.id) });
}

const schema = z.object({ currentPassword: z.string().min(1).max(200) });

/** שמירת כרטיס מדומה לבדיקות. מחייב אימות בעלות בסיסמת האתר, מוגבל בניסיונות, ומוגן מפני CSRF. אינו מקבל פרטי כרטיס */
export async function POST(request: Request) {
  const provider = gate();
  if (!provider) return notFound();
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "בקשה לא מורשית" }, { status: 403 });
  if (!isJsonRequest(request)) return NextResponse.json({ error: "פורמט בקשה לא נתמך" }, { status: 415 });
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "נתונים לא תקינים" }, { status: 400 });

  try {
    const res = await addMockCard({ userId: session.user.id, currentPassword: parsed.data.currentPassword, provider });
    switch (res.status) {
      case "OK":
        return NextResponse.json({ method: res.method }, { status: 201 });
      case "INVALID_PASSWORD":
        return NextResponse.json({ error: "הסיסמה שגויה", attemptsLeft: res.attemptsLeft }, { status: 400 });
      case "BLOCKED":
        return NextResponse.json(
          { error: "בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר", retryAfterSeconds: res.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(res.retryAfterSeconds) } }
        );
      case "LIMIT":
        return NextResponse.json({ error: "ניתן לשמור עד שלושה אמצעי תשלום" }, { status: 409 });
      case "NOT_ALLOWED":
        return NextResponse.json({ error: "לא ניתן לשמור אמצעי תשלום בחשבון זה כרגע" }, { status: 403 });
      case "NOT_SANDBOX":
        return notFound();
    }
  } catch (err) {
    console.error("[payment-methods] add failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "שגיאה בשמירת אמצעי התשלום" }, { status: 500 });
  }
}
