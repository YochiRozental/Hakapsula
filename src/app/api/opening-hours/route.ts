import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadDay, trackForUser } from "@/lib/opening-hours-db";
import { openingHoursResponseFor, parseDateKey } from "@/lib/opening-hours";

/**
 * שעות הפעילות ליום מסוים. מנהל (לצורך ניהול/יומן/תור ידני) מקבל את היום המלא, כולל שני המסלולים.
 * לקוח (ואורח) מקבלים מהשרת רק את חלונות המסלול שלו לפי מגדרו — בלי שום מידע על המסלול האחר, כך שאין דרך
 * לדעת על קיומו דרך תשובת ה-API. ראו openingHoursResponseFor (לוגיקה טהורה, נבדקת ישירות). userTrack: מסלול
 * המשתמש המחובר (אחרת null).
 */
export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !parseDateKey(date)) {
    return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
  }
  const session = await auth();
  const role = session?.user?.role === "ADMIN" ? "ADMIN" : session?.user?.role === "CLIENT" ? "CLIENT" : null;
  const day = await loadDay(date);
  const userTrack = role === "CLIENT" ? ((await trackForUser(session!.user.id)) ?? null) : null;
  return NextResponse.json({ ...openingHoursResponseFor(day, role, userTrack ?? undefined), userTrack });
}
