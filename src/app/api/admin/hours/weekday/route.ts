import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { BookingError } from "@/lib/booking-error";
import { loadSaveResult, replaceWeekday } from "@/lib/opening-hours-db";
import { parseWindowsBody } from "../parse";

export async function PUT(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const weekday = body?.weekday;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return NextResponse.json({ error: "יום לא תקין" }, { status: 400 });
  }
  const windows = parseWindowsBody(body?.windows);
  if (!windows) return NextResponse.json({ error: "חלונות לא תקינים" }, { status: 400 });

  try {
    await replaceWeekday(weekday, windows);
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return NextResponse.json(await loadSaveResult());
}
