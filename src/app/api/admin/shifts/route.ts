import { NextResponse } from "next/server";
import { listShiftsAdmin } from "@/lib/shifts/views";
import { createShift } from "@/lib/shifts/schedule";
import { gateProvider, int, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";
import type { RoomKey } from "@/generated/prisma/client";

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

/**
 * יצירת משמרת עבור לקוח ע"י מנהל, כולל מסלול תשלום ידני (paymentMode = MANUAL): בלי אמצעי תשלום שמור ובלי חיוב אוטומטי,
 * והמנהל מתעד כל תשלום שהתקבל. הלקוח חייב להיות זכאי (אישור זכאות נבדק בשרת). בדיקות התנגשות, שעות פעילות ומסלול זהות
 * להזמנה רגילה. אידמפוטנטי לפי clientKey.
 */
export async function POST(request: Request) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const body = await readJson(request);
  const userId = str(body?.userId);
  const roomKey = str(body?.roomKey) as RoomKey | undefined;
  const weekday = int(body?.weekday);
  const windowId = str(body?.windowId);
  const startDate = str(body?.startDate);
  const clientKey = str(body?.clientKey);
  const paymentMode = body?.paymentMode === "MANUAL" ? "MANUAL" : body?.paymentMode === "AUTO" ? "AUTO" : undefined;
  if (!userId || !roomKey || weekday === undefined || !windowId || !startDate || !clientKey || !paymentMode) {
    return NextResponse.json({ error: "חסרים פרטים ליצירת המשמרת" }, { status: 400 });
  }
  try {
    const result = await createShift({ userId, roomKey, weekday, windowId, startDate, clientKey, provider, createdById: admin.user.id, paymentMode });
    return NextResponse.json(result, { status: result.status === "ACTIVE" ? 201 : result.status === "PENDING_REVIEW" ? 202 : 402 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
