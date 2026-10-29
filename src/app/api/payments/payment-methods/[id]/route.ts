import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getFlowProvider } from "@/lib/payments/flow";
import { isMockCardEnabled } from "@/lib/payments/mock-card-flag";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { removePaymentMethod } from "@/lib/payments/saved-methods";
import { PaymentFlowError } from "@/lib/payments/shared";
import { isSameOriginRequest } from "@/lib/same-origin";

/** הסרת אמצעי תשלום שמור של המשתמש עצמו בלבד (בעלות נבדקת בשירות). אותו שער והגנת CSRF כמו ההוספה */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = getFlowProvider();
  if (!isMockCardEnabled() || !(provider instanceof MockPaymentProvider)) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "בקשה לא מורשית" }, { status: 403 });
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });

  const { id } = await params;
  try {
    await removePaymentMethod({ userId: session.user.id, methodId: id, provider });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PaymentFlowError && err.code === "NOT_FOUND") return NextResponse.json({ error: "לא נמצא" }, { status: 404 });
    console.error("[payment-methods] remove failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "שגיאה בהסרת אמצעי התשלום" }, { status: 500 });
  }
}
