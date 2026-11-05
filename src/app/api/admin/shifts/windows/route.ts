import { NextResponse } from "next/server";
import { listShiftWindows, saveShiftWindows } from "@/lib/shifts/windows-db";
import type { WindowInput } from "@/lib/shifts/windows";
import { gateProvider, mutationGuard, notFound, readJson, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/** כל המשבצות (כולל מושבתות) לעריכה. הרשאת מנהל נבדקת בשרת מול המסד */
export async function GET() {
  if (!gateProvider()) return notFound();
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  try {
    return NextResponse.json({ windows: await listShiftWindows() });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}

function parseWindows(value: unknown): WindowInput[] | null {
  if (!Array.isArray(value)) return null;
  const out: WindowInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const w = item as Record<string, unknown>;
    if (typeof w.name !== "string" || typeof w.active !== "boolean") return null;
    if (typeof w.startMinutes !== "number" || typeof w.endMinutes !== "number" || typeof w.monthlyPriceShekel !== "number") return null;
    if (w.id !== undefined && typeof w.id !== "string") return null;
    out.push({ id: w.id as string | undefined, name: w.name, startMinutes: w.startMinutes, endMinutes: w.endMinutes, monthlyPriceShekel: w.monthlyPriceShekel, active: w.active });
  }
  return out;
}

/**
 * שמירת המשבצות (שעות ומחיר חודשי בשקלים שלמים). משפיע על הזמנות חדשות ועל שינויים מאושרים בלבד: מופעים וחיובים קיימים
 * אינם משתנים. האימות נעשה בשרת, וכל שינוי נרשם ביומן הביקורת.
 */
export async function PUT(request: Request) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  const body = await readJson(request);
  const windows = parseWindows(body?.windows);
  if (!windows) return NextResponse.json({ error: "נתונים לא תקינים" }, { status: 400 });
  try {
    return NextResponse.json({ windows: await saveShiftWindows({ adminId: admin.user.id, windows }) });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
