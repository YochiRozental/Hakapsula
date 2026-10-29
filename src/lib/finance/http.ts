import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { PaymentProvider } from "@/lib/payments/provider";
import { PaymentFlowError } from "@/lib/payments/shared";
import { isJsonRequest, isSameOriginRequest } from "@/lib/same-origin";
import { FinanceError } from "@/lib/finance/errors";
import { getFinanceProvider } from "@/lib/finance/gate";
import { BookingError } from "@/lib/booking-error";
import { ShiftError } from "@/lib/shifts/errors";

/** עזרי נתיבי HTTP של הניהול הכספי: שער, הרשאת מנהל (מול המסד, לא מול ה-JWT), CSRF ומיפוי שגיאות ללא חשיפת פרטים פנימיים */

export const notFound = () => NextResponse.json({ error: "לא נמצא" }, { status: 404 });
export const gateProvider = (): PaymentProvider | null => getFinanceProvider();

type Auth = { user: { id: string }; response?: undefined } | { response: NextResponse; user?: undefined };

export async function requireAdminUser(): Promise<Auth> {
  const session = await auth();
  if (!session?.user) return { response: NextResponse.json({ error: "יש להתחבר" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (user?.role !== "ADMIN") return { response: NextResponse.json({ error: "אין הרשאה" }, { status: 403 }) };
  return { user: { id: user.id } };
}

export function mutationGuard(request: Request): NextResponse | null {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "בקשה לא מורשית" }, { status: 403 });
  if (!isJsonRequest(request)) return NextResponse.json({ error: "פורמט בקשה לא נתמך" }, { status: 415 });
  return null;
}

const FLOW_STATUS = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  EXPIRED: 410,
  INVALID: 400,
  CONFLICT: 409,
  INSUFFICIENT_BALANCE: 409,
  PLAN_CHANGED: 409,
  NO_PAYMENT_METHOD: 409,
  PROVIDER_ERROR: 502,
} as const;

export function financeErrorResponse(err: unknown) {
  if (err instanceof FinanceError) {
    const status = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID: 400, CONFLICT: 409, PROVIDER_UNKNOWN: 202 }[err.code];
    return NextResponse.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, { status });
  }
  if (err instanceof ShiftError) {
    const status = ({ NOT_FOUND: 404, FORBIDDEN: 403, INVALID: 400, CONFLICT: 409 } as Record<string, number>)[err.code] ?? 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  if (err instanceof PaymentFlowError) return NextResponse.json({ error: err.message, code: err.code }, { status: FLOW_STATUS[err.code] });
  if (err instanceof BookingError) return NextResponse.json({ error: err.message, code: "BOOKING" }, { status: 409 });
  // לא מחזירים פרטים פנימיים: הודעת שגיאה עלולה להכיל נתוני בקשה
  console.error("[finance] unexpected error", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "שגיאה בעיבוד הבקשה" }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

/** פרמטר תאריך (YYYY-MM-DD) לגבולות טווח, ב-UTC. end=true מחזיר את תחילת היום שאחריו (גבול עליון בלעדי) */
export function dateParam(v: string | null, end = false): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return end ? new Date(d.getTime() + 86_400_000) : d;
}

/** עוטף נתיב ניהול: שער, (CSRF לכתיבה), מנהל, ומיפוי שגיאות */
export async function adminRoute(
  request: Request,
  opts: { write: boolean },
  handler: (ctx: { admin: { id: string }; provider: PaymentProvider }) => Promise<NextResponse>
): Promise<NextResponse> {
  const provider = gateProvider();
  if (!provider) return notFound();
  if (opts.write) {
    const blocked = mutationGuard(request);
    if (blocked) return blocked;
  }
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  try {
    return await handler({ admin: admin.user, provider });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
