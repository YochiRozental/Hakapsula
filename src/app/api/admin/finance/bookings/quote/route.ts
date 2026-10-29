import { NextResponse } from "next/server";
import type { RoomKey } from "@/generated/prisma/client";
import { adminRoute, int, readJson, str } from "@/lib/finance/http";
import { quoteDebtBooking } from "@/lib/finance/debt-booking";
import { FinanceError } from "@/lib/finance/errors";

/** הצגת סכום ההזמנה והחוב שייווצר לפני אישור מנהל. אינה יוצרת דבר */
export async function POST(request: Request) {
  return adminRoute(request, { write: true }, async () => {
    const b = await readJson(request);
    const userId = str(b.userId);
    const date = str(b.date);
    const start = str(b.start);
    const roomKey = str(b.roomKey);
    const durationMinutes = int(b.durationMinutes);
    if (!userId || !date || !start || !roomKey || durationMinutes === undefined) throw new FinanceError("חסרים פרטים", "INVALID");
    return NextResponse.json(await quoteDebtBooking({ userId, roomKey: roomKey as RoomKey, date, start, durationMinutes }));
  });
}
