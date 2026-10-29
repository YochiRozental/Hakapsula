import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { startPackagePurchase } from "@/lib/payments/packages";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/**
 * פתיחת רכישת חבילה. נקלטים רק מספר השעות ומפתח אידמפוטנטיות; המחיר נקבע בשרת. החבילה נוצרת רק אחרי שהתשלום
 * אומת בצד השרת (GET /api/payments/[id] או webhook). כשאין ספק מוגדר הנתיב מחזיר 404.
 */
export async function POST(request: Request) {
  const provider = getFlowProvider();
  if (!provider) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const hours = Number(body?.hours);
  const clientKey = typeof body?.clientKey === "string" ? body.clientKey : "";
  if (!Number.isInteger(hours)) return NextResponse.json({ error: "חבילה לא תקינה" }, { status: 400 });

  try {
    const started = await startPackagePurchase({ userId: session.user.id, hours, clientKey, provider });
    return NextResponse.json(started);
  } catch (err) {
    return errorResponse(err);
  }
}
