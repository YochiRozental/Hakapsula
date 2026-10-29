import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { decideRefundException } from "@/lib/finance/refunds";

/** אישור או דחייה של חריג מדיניות ההחזר להזמנה שבוטלה מאוחר (מנהל בלבד, סיבה חובה) */
export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin, provider }) => {
    const b = await readJson(request);
    const res = await decideRefundException({ appointmentId: (await params).appointmentId, adminId: admin.id, provider, decision: b.decision, reason: b.reason, waiveDebt: b.waiveDebt === true });
    return NextResponse.json(res);
  });
}
