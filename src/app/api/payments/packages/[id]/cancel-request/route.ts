import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requestPackageCancellation } from "@/lib/payments/packages";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/**
 * הגשת בקשת ביטול חבילה. הבקשה רק נרשמת לטיפול מנהל: אינה מבטלת את החבילה ואינה מבצעת החזר.
 * לחבילה בבעלות המשתמש בלבד, ובקשה פתוחה אחת לכל חבילה.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!getFlowProvider()) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  try {
    const created = await requestPackageCancellation({
      userId: session.user.id,
      packageId: id,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
