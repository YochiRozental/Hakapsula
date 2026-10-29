import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { getCustomerFinance } from "@/lib/finance/overview";
import { FinanceError } from "@/lib/finance/errors";
import { getShiftsProvider } from "@/lib/shifts/gate";

/** כרטיס כספי של לקוח אחד (מנהל בלבד). הלקוח עצמו אינו יכול לגשת לנתיב הזה */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: false }, async () => {
    const card = await getCustomerFinance((await params).id, getShiftsProvider() !== null);
    if (!card) throw new FinanceError("הלקוח לא נמצא", "NOT_FOUND");
    return NextResponse.json(card);
  });
}
