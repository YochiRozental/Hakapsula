import { NextResponse } from "next/server";
import { suspendShiftManually } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/** השעיה ידנית של משמרת פעילה. המשבצות נשמרות; אין ביטול. מנהל בלבד */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  try {
    await suspendShiftManually({ shiftId: id, adminId: admin.user.id, reason: str(body?.reason) ?? "" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
