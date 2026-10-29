import { NextResponse } from "next/server";
import { setShiftEligibility } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/** מנהל מעניק או שולל זכאות להזמנת משמרות. לקוח אינו יכול להעניק לעצמו (נבדק בשרת). שלילה אינה מבטלת משמרות קיימות */
export async function PATCH(request: Request) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const body = await readJson(request);
  const userId = str(body?.userId);
  if (!userId || typeof body?.allowed !== "boolean") return NextResponse.json({ error: "נתונים חסרים" }, { status: 400 });
  try {
    return NextResponse.json(await setShiftEligibility({ adminId: admin.user.id, userId, allowed: body.allowed }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
