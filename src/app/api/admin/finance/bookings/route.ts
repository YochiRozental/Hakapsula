import { NextResponse } from "next/server";
import type { RoomKey } from "@/generated/prisma/client";
import { adminRoute, int, readJson, str } from "@/lib/finance/http";
import { approveBookingWithDebt } from "@/lib/finance/debt-booking";
import { FinanceError } from "@/lib/finance/errors";

/**
 * אישור הזמנה ללא תשלום מראש, עם חוב. מנהל בלבד. נדרשים אישור מפורש (confirm) וסכום החוב הצפוי כפי שהוצג (נבדק מחדש בשרת).
 * ההזמנה, החוב ורשומת הביקורת נוצרים באופן אטומי, עם אותן בדיקות זמינות חדר של הזמנה רגילה
 */
export async function POST(request: Request) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const b = await readJson(request);
    const userId = str(b.userId);
    const date = str(b.date);
    const start = str(b.start);
    const roomKey = str(b.roomKey);
    const durationMinutes = int(b.durationMinutes);
    if (!userId || !date || !start || !roomKey || durationMinutes === undefined) throw new FinanceError("חסרים פרטים", "INVALID");
    const res = await approveBookingWithDebt({
      adminId: admin.id,
      userId,
      roomKey: roomKey as RoomKey,
      date,
      start,
      durationMinutes,
      reason: str(b.reason),
      confirm: b.confirm,
      expectedDebtAgorot: b.expectedDebtAgorot,
    });
    return NextResponse.json(res, { status: 201 });
  });
}
