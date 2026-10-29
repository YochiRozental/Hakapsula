import { NextResponse } from "next/server";
import { listShiftsAdmin } from "@/lib/shifts/views";
import { gateProvider, notFound, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/** כל המשמרות עם סינון לפי לקוח (שם/אימייל/טלפון), חדר, יום וסטטוס. הרשאת מנהל נבדקת בשרת מול המסד */
export async function GET(request: Request) {
  if (!gateProvider()) return notFound();
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const q = new URL(request.url).searchParams;
  const weekday = q.get("weekday");
  try {
    const rows = await listShiftsAdmin({
      status: q.get("status") || undefined,
      roomKey: q.get("roomKey") || undefined,
      weekday: weekday !== null && weekday !== "" && Number.isInteger(Number(weekday)) ? Number(weekday) : undefined,
      query: q.get("q") || undefined,
    });
    return NextResponse.json({ shifts: rows });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
