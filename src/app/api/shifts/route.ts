import { NextResponse } from "next/server";
import { createShift } from "@/lib/shifts/schedule";
import { reauthenticateForShift } from "@/lib/shifts/reauth";
import { getMyShifts } from "@/lib/shifts/views";
import { ShiftError } from "@/lib/shifts/errors";
import { gateProvider, int, mutationGuard, notFound, readJson, requireClient, shiftErrorResponse, str } from "@/lib/shifts/http";
import type { RoomKey } from "@/generated/prisma/client";

/** המשמרות שלי: רשימה, זכאות, וכרטיס שמיש. הנתיב קיים רק כשהשער פתוח (404 אחרת) ומחזיר נתוני המשתמש עצמו בלבד */
export async function GET() {
  const provider = gateProvider();
  if (!provider) return notFound();
  const authed = await requireClient();
  if (authed.response) return authed.response;
  try {
    return NextResponse.json(await getMyShifts({ userId: authed.user.id, provider }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}

/**
 * יצירת משמרת. הזכאות נבדקת בשרת מול המסד; הלקוח מאמת מחדש בסיסמת האתר (מוגבל בניסיונות); נדרש אמצעי תשלום שמיש;
 * הבדיקה והיצירה אטומיות תחת נעילת החדר; החיוב הראשון בוצע לפני אישור. המחיר והסכומים נקבעים בשרת בלבד.
 */
export async function POST(request: Request) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const authed = await requireClient();
  if (authed.response) return authed.response;

  const body = await readJson(request);
  const roomKey = str(body?.roomKey) as RoomKey | undefined;
  const weekday = int(body?.weekday);
  const windowId = str(body?.windowId);
  const startDate = str(body?.startDate);
  const clientKey = str(body?.clientKey);
  if (!roomKey || weekday === undefined || !windowId || !startDate || !clientKey) {
    return NextResponse.json({ error: "חסרים פרטים ליצירת המשמרת" }, { status: 400 });
  }

  try {
    await reauthenticateForShift({ userId: authed.user.id, password: body?.currentPassword });
    const result = await createShift({ userId: authed.user.id, roomKey, weekday, windowId, startDate, clientKey, provider });
    return NextResponse.json(result, { status: result.status === "ACTIVE" ? 201 : result.status === "PENDING_REVIEW" ? 202 : 402 });
  } catch (err) {
    if (err instanceof ShiftError) return shiftErrorResponse(err);
    return shiftErrorResponse(err);
  }
}
