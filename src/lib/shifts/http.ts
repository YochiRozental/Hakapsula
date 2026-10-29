import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { PaymentProvider } from "@/lib/payments/provider";
import { isJsonRequest, isSameOriginRequest } from "@/lib/same-origin";
import { ShiftError } from "@/lib/shifts/errors";
import { getShiftsProvider } from "@/lib/shifts/gate";

/** עזרי נתיבי HTTP של משמרות: שער, הרשאות (נבדקות מול המסד, לא מול ה-JWT), הגנת CSRF ומיפוי שגיאות */

export const notFound = () => NextResponse.json({ error: "לא נמצא" }, { status: 404 });

/** ספק המשמרות כשהשער פתוח, אחרת null (והנתיב מחזיר 404 כאילו אינו קיים) */
export const gateProvider = (): PaymentProvider | null => getShiftsProvider();

type Auth<T> = ({ user: T } & { response?: undefined }) | { response: NextResponse; user?: undefined };

export async function requireClient(): Promise<Auth<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { response: NextResponse.json({ error: "יש להתחבר" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true, mustChangePassword: true } });
  if (!user) return { response: NextResponse.json({ error: "יש להתחבר" }, { status: 401 }) };
  if (user.role !== "CLIENT") return { response: NextResponse.json({ error: "אין הרשאה" }, { status: 403 }) };
  if (user.mustChangePassword) return { response: NextResponse.json({ error: "יש להחליף סיסמה זמנית קודם" }, { status: 403 }) };
  return { user: { id: user.id } };
}

export async function requireAdminUser(): Promise<Auth<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { response: NextResponse.json({ error: "יש להתחבר" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (user?.role !== "ADMIN") return { response: NextResponse.json({ error: "אין הרשאה" }, { status: 403 }) };
  return { user: { id: user.id } };
}

/** פעולת שינוי מחייבת אותו מקור ו-JSON (בנוסף לעוגיית ה-Session): הגנת CSRF */
export function mutationGuard(request: Request): NextResponse | null {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "בקשה לא מורשית" }, { status: 403 });
  if (!isJsonRequest(request)) return NextResponse.json({ error: "פורמט בקשה לא נתמך" }, { status: 415 });
  return null;
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID: 400,
  CONFLICT: 409,
  NO_PAYMENT_METHOD: 409,
  BLOCKED: 429,
  INVALID_PASSWORD: 400,
};

export function shiftErrorResponse(err: unknown) {
  if (err instanceof ShiftError) {
    const headers: Record<string, string> = {};
    if (err.code === "BLOCKED" && err.details?.retryAfterSeconds) headers["Retry-After"] = String(err.details.retryAfterSeconds);
    return NextResponse.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, { status: STATUS[err.code] ?? 400, headers });
  }
  // לא מחזירים פרטים פנימיים: הודעת שגיאה עלולה להכיל נתוני בקשה
  console.error("[shifts] unexpected error", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "שגיאה בעיבוד הבקשה" }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
