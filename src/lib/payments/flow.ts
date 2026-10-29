import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { BookingError } from "@/lib/booking";
import { prisma } from "@/lib/prisma";
import { getMissingBookingDetails } from "@/lib/profile";
import { getRuntimeProvider } from "@/lib/payments/runtime";
import { PaymentFlowError } from "@/lib/payments/booking-payment";
import { WebhookVerificationError, type PaymentProvider } from "@/lib/payments/provider";

/**
 * שער לכל נקודות הקצה של זרימת התשלום. הזרימה פעילה רק כשיש ספק תקף לפי getPaymentProvider
 * (כיום: Mock בסביבת sandbox מקומית בלבד). באתר החי אין ספק מוגדר, ולכן כל הנתיבים מחזירים 404 כאילו אינם קיימים.
 */
export function getFlowProvider(): PaymentProvider | null {
  return getRuntimeProvider();
}

export function notFound() {
  return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
}

type SessionUser = { id: string; role: string };

/** משתמש מחובר שרשאי להזמין: פרטים מלאים ואושר, נבדק מול המסד (כמו ב-POST /api/appointments) */
export async function requireBookingUser(): Promise<{ user: SessionUser } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user) return { response: NextResponse.json({ error: "יש להתחבר", code: "AUTH_REQUIRED" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) return { response: NextResponse.json({ error: "יש להתחבר", code: "AUTH_REQUIRED" }, { status: 401 }) };
  const missing = getMissingBookingDetails(user);
  if (missing.length > 0) {
    return { response: NextResponse.json({ error: "יש להשלים את פרטי החשבון", code: "PROFILE_INCOMPLETE", missing }, { status: 422 }) };
  }
  if (user.status !== "APPROVED") {
    return { response: NextResponse.json({ error: "החשבון טרם אושר", code: "NOT_APPROVED" }, { status: 403 }) };
  }
  return { user: { id: user.id, role: user.role } };
}

/** מנהל מחובר. התפקיד נבדק מול המסד ולא מול ה-JWT */
export async function requireAdminUser(): Promise<{ user: SessionUser } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user) return { response: NextResponse.json({ error: "יש להתחבר" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (user?.role !== "ADMIN") return { response: NextResponse.json({ error: "אין הרשאה" }, { status: 403 }) };
  return { user };
}

export function errorResponse(err: unknown) {
  if (err instanceof PaymentFlowError) {
    const status = { NOT_FOUND: 404, FORBIDDEN: 403, EXPIRED: 410, INVALID: 400, CONFLICT: 409, INSUFFICIENT_BALANCE: 409, PLAN_CHANGED: 409, NO_PAYMENT_METHOD: 409, PROVIDER_ERROR: 502 }[err.code];
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  if (err instanceof BookingError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof WebhookVerificationError) return NextResponse.json({ error: "חתימה לא תקינה" }, { status: 401 });
  // לא מחזירים פרטי שגיאה פנימיים ללקוח
  console.error("[payments] unexpected error", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "שגיאה בעיבוד הבקשה" }, { status: 500 });
}
