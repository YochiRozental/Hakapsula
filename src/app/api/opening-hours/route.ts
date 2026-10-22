import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadDay, trackForUser } from "@/lib/opening-hours-db";
import { parseDateKey } from "@/lib/opening-hours";

// שעות הפעילות ליום מסוים — ציבורי (כמו זמינות החדרים), ללא פרטי משתמשים.
// userTrack: מסלול המשתמש המחובר לפי המגדר שלו (אחרת null) — המסך מציג רק חלונות שמתאימים לו, והשרת אוכף זאת בהזמנה
export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !parseDateKey(date)) {
    return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
  }
  const session = await auth();
  const userTrack = session?.user?.role === "CLIENT" ? ((await trackForUser(session.user.id)) ?? null) : null;
  return NextResponse.json({ ...(await loadDay(date)), userTrack });
}
