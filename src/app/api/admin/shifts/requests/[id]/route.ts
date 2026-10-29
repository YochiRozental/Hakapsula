import { NextResponse } from "next/server";
import { decideShiftRequest } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/** אישור או דחייה של בקשת שינוי/ביטול. מנהל בלבד. החלטה מתועדת; החזר על חודש ששולם רק אם בוקש במפורש (refundCharged) */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  const decision = body?.decision === "APPROVE" ? "APPROVE" : body?.decision === "REJECT" ? "REJECT" : null;
  if (!decision) return NextResponse.json({ error: "החלטה לא תקינה" }, { status: 400 });
  try {
    const result = await decideShiftRequest({
      requestId: id,
      adminId: admin.user.id,
      decision,
      note: str(body?.note),
      effectiveFrom: str(body?.effectiveFrom),
      refundCharged: body?.refundCharged === true,
      provider,
    });
    return NextResponse.json(result);
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
