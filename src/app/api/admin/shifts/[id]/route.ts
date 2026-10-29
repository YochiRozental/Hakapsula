import { NextResponse } from "next/server";
import { getShiftAdminDetail } from "@/lib/shifts/views";
import { gateProvider, notFound, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/** פרטי משמרת למנהל: מופעים, חיובים, כישלונות ובקשות */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  try {
    const detail = await getShiftAdminDetail(id);
    return detail ? NextResponse.json(detail) : NextResponse.json({ error: "המשמרת לא נמצאה" }, { status: 404 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
