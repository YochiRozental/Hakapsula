import { NextResponse } from "next/server";
import { recordManualPayment, resolveUnknownCharge, retryChargeAsAdmin } from "@/lib/shifts/lifecycle";
import { gateProvider, int, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/**
 * טיפול מנהל בחיוב חודשי: ניסיון חוזר אחרי כישלון ודאי (retry), או בירור של חיוב במצב "לא ידוע" לפי בדיקה מול הספק
 * (resolve-paid / resolve-not-charged), או תיעוד תשלום ידני שהתקבל בפועל (manual-payment: סכום, תאריך, אישור מפורש).
 * חיוב לא ידוע לעולם לא מחויב שוב אוטומטית. תשלום ידני לא מסומן כשולם בלי confirm: true.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  const action = str(body?.action);
  try {
    if (action === "retry") return NextResponse.json(await retryChargeAsAdmin({ chargeId: id, adminId: admin.user.id, provider }));
    if (action === "manual-payment") {
      return NextResponse.json(
        await recordManualPayment({
          chargeId: id,
          adminId: admin.user.id,
          amountAgorot: int(body?.amountAgorot) ?? Number.NaN,
          paidOn: str(body?.paidOn) ?? "",
          reference: str(body?.reference),
          confirm: body?.confirm === true,
        })
      );
    }
    if (action === "resolve-paid" || action === "resolve-not-charged") {
      return NextResponse.json(
        await resolveUnknownCharge({ chargeId: id, adminId: admin.user.id, outcome: action === "resolve-paid" ? "PAID" : "NOT_CHARGED", note: str(body?.note) })
      );
    }
    return NextResponse.json({ error: "פעולה לא תקינה" }, { status: 400 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
