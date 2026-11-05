import { NextResponse } from "next/server";
import { scheduleMakeupSession, waiveOccurrenceMakeup } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";
import type { RoomKey } from "@/generated/prisma/client";

/**
 * ניהול שעה חלופית ללקוח אחרי סגירה ביוזמת ההנהלה (הזיכוי בדקות ניתן אוטומטית בסגירה):
 *  - action "schedule": שיבוץ שעה חלופית (חדר, התחלה, סיום) שנגרעת מיתרת הזיכוי, בלי ניצול כפול ובלי חריגה מהיתרה.
 *  - action "waive": ויתור מפורש שמאפס את היתרה שטרם נוצלה.
 * אין לכך השפעה על חיובי המשמרת. מנהל בלבד; הרשאה נבדקת בשרת מול המסד, וכל פעולה נרשמת ביומן הביקורת.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const { id } = await params;
  const body = await readJson(request);
  const action = str(body?.action);
  try {
    if (action === "waive") return NextResponse.json(await waiveOccurrenceMakeup({ occurrenceId: id, adminId: admin.user.id, note: str(body?.note) }));
    if (action === "schedule") {
      const roomKey = str(body?.roomKey) as RoomKey | undefined;
      const start = new Date(str(body?.startTime) ?? "");
      const end = new Date(str(body?.endTime) ?? "");
      if (!roomKey || !CONFLICTING_ROOM_KEYS[roomKey] || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return NextResponse.json({ error: "חסרים פרטי שיבוץ" }, { status: 400 });
      }
      return NextResponse.json(await scheduleMakeupSession({ occurrenceId: id, adminId: admin.user.id, roomKey, startTime: start, endTime: end }), { status: 201 });
    }
    return NextResponse.json({ error: "פעולה לא תקינה" }, { status: 400 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
