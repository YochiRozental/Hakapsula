import { NextResponse } from "next/server";
import { replaceDate } from "@/lib/opening-hours-db";
import { jerusalemParts, parseDateKey } from "@/lib/opening-hours";
import { applyDayClosure } from "@/lib/shifts/lifecycle";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse, str } from "@/lib/shifts/http";
import { BookingError } from "@/lib/booking-error";

/**
 * סגירה מפורשת של יום ע"י מנהל, יחד עם השפעתה על משמרות קיימות באותו יום (דילוג בלי חיוב, החזר אם החודש שולם). סוגר את
 * היום באותו מנגנון חריגים של שעות הפעילות. אידמפוטנטי: הרצה חוזרת משלימה החזרים שנכשלו. מנהל בלבד
 */
export async function POST(request: Request) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const body = await readJson(request);
  const date = str(body?.date);
  if (!date || !parseDateKey(date)) return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
  if (date < jerusalemParts(new Date()).date) return NextResponse.json({ error: "לא ניתן לסגור תאריך שעבר" }, { status: 400 });
  try {
    await replaceDate(date, { closed: true, note: str(body?.note) ?? null });
    const effects = await applyDayClosure({ date, adminId: admin.user.id, provider });
    return NextResponse.json(effects);
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message }, { status: 400 });
    return shiftErrorResponse(err);
  }
}
