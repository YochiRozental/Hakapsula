import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { BookingError } from "@/lib/booking-error";
import { clearDate, loadSaveResult, replaceDate } from "@/lib/opening-hours-db";
import { jerusalemParts, parseDateKey } from "@/lib/opening-hours";
import { parseWindowsBody } from "../parse";

export async function PUT(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const date = body?.date;
  if (typeof date !== "string" || !parseDateKey(date)) {
    return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
  }
  if (date < jerusalemParts(new Date()).date) {
    return NextResponse.json({ error: "לא ניתן להגדיר חריג לתאריך שעבר" }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note : null;

  try {
    if (body?.closed === true) {
      await replaceDate(date, { closed: true, note });
    } else {
      const windows = parseWindowsBody(body?.windows);
      if (!windows) return NextResponse.json({ error: "חלונות לא תקינים" }, { status: 400 });
      await replaceDate(date, { closed: false, windows, note });
    }
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return NextResponse.json(await loadSaveResult());
}

export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const date = new URL(request.url).searchParams.get("date");
  if (!date || !parseDateKey(date)) {
    return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
  }
  await clearDate(date);
  return NextResponse.json(await loadSaveResult());
}
