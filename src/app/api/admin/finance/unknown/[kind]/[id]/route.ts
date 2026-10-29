import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { FinanceError } from "@/lib/finance/errors";
import { recordInquiryNote, resolvePaymentManually, resolveShiftChargeUnknown, verifyPayment } from "@/lib/finance/unknown";
import { resolveRefundManually, sendUnsentRefund, verifyRefund } from "@/lib/finance/refunds";
import { getShiftsProvider } from "@/lib/shifts/gate";

/**
 * פעולות על פריט בתור הבירור. kind: payment | refund | shift-charge. action: verify (אימות מול הספק), resolve (הכרעה מתועדת
 * עם אסמכתה, רק כשאי אפשר לאמת), note (תיעוד בירור), send (רק להחזר שמעולם לא נשלח). אין סימון שרירותי: ראו unknown.ts
 */
export async function POST(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin, provider }) => {
    const { kind, id } = await params;
    const b = await readJson(request);
    const action = typeof b.action === "string" ? b.action : "";

    if (action === "note") {
      const entityType = kind === "payment" ? "Payment" : kind === "refund" ? "Refund" : kind === "shift-charge" ? "ShiftCharge" : null;
      if (!entityType) throw new FinanceError("סוג לא תקין", "INVALID");
      return NextResponse.json(await recordInquiryNote({ entityType, entityId: id, adminId: admin.id, note: b.note }));
    }
    if (kind === "payment") {
      if (action === "verify") return NextResponse.json(await verifyPayment({ paymentId: id, adminId: admin.id, provider }));
      if (action === "resolve") return NextResponse.json(await resolvePaymentManually({ paymentId: id, adminId: admin.id, provider, outcome: b.outcome, evidence: b.evidence, note: b.note }));
    }
    if (kind === "refund") {
      if (action === "verify") return NextResponse.json(await verifyRefund({ refundId: id, adminId: admin.id, provider }));
      if (action === "resolve") return NextResponse.json(await resolveRefundManually({ refundId: id, adminId: admin.id, provider, outcome: b.outcome, evidence: b.evidence, note: b.note }));
      if (action === "send") return NextResponse.json(await sendUnsentRefund({ refundId: id, adminId: admin.id, provider }));
    }
    if (kind === "shift-charge" && action === "resolve") {
      if (!getShiftsProvider()) throw new FinanceError("מודול המשמרות סגור", "NOT_FOUND");
      return NextResponse.json(await resolveShiftChargeUnknown({ chargeId: id, adminId: admin.id, provider, outcome: b.outcome, evidence: b.evidence, note: b.note }));
    }
    throw new FinanceError("פעולה לא תקינה", "INVALID");
  });
}
