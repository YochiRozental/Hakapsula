import { NextResponse } from "next/server";
import { adminRoute, dateParam, readJson, str } from "@/lib/finance/http";
import { issueAdminRefund, listRefundExceptions, listRefunds } from "@/lib/finance/refunds";
import { FinanceError } from "@/lib/finance/errors";

/** החזרים וחריגי החזר שממתינים להכרעה */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams;
    const [refunds, exceptions] = await Promise.all([
      listRefunds({ userId: q.get("userId") || undefined, status: q.get("status") || undefined, from: dateParam(q.get("from")), to: dateParam(q.get("to"), true) }),
      listRefundExceptions(),
    ]);
    return NextResponse.json({ refunds, exceptions });
  });
}

/** החזר מנהל (סכום עד היתרה הניתנת להחזר) דרך שכבת הספק. כל הכסף עובר דרך הספק; מוצלח רק אחרי אישורו */
export async function POST(request: Request) {
  return adminRoute(request, { write: true }, async ({ admin, provider }) => {
    const b = await readJson(request);
    const paymentId = str(b.paymentId);
    if (!paymentId) throw new FinanceError("חסר מזהה תשלום", "INVALID");
    const res = await issueAdminRefund({ paymentId, adminId: admin.id, provider, amountAgorot: b.amountAgorot, reason: b.reason, clientKey: b.clientKey, exception: b.exception === true });
    return NextResponse.json(res, { status: res.status === "UNKNOWN" ? 202 : 200 });
  });
}
