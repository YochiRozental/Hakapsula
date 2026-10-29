import { NextResponse } from "next/server";
import { resumeShift } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";

/** חידוש משמרת מושעית אחרי הסדרת חוב. בלי הסדרה נדרש ויתור מפורש (waiveUnpaid). מנהל בלבד */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  try {
    return NextResponse.json(await resumeShift({ shiftId: id, adminId: admin.user.id, waiveUnpaid: body?.waiveUnpaid === true, note: str(body?.note) }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
