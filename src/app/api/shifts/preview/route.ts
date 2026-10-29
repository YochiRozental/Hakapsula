import { NextResponse } from "next/server";
import { previewShift } from "@/lib/shifts/schedule";
import { gateProvider, int, mutationGuard, notFound, readJson, requireClient, shiftErrorResponse, str } from "@/lib/shifts/http";
import type { RoomKey } from "@/generated/prisma/client";

/**
 * תצוגה מקדימה של משמרת לפני אישור: פירוט המופעים, מחיר למופע, החיוב הראשון והחיובים הבאים, והתנגשויות.
 * קריאה בלבד: לא נועלת ולא שומרת. האימות המחייב נעשה שוב ביצירה, תחת נעילה.
 */
export async function POST(request: Request) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const authed = await requireClient();
  if (authed.response) return authed.response;

  const body = await readJson(request);
  const roomKey = str(body?.roomKey) as RoomKey | undefined;
  const weekday = int(body?.weekday);
  const windowId = str(body?.windowId);
  const startDate = str(body?.startDate);
  if (!roomKey || weekday === undefined || !windowId || !startDate) {
    return NextResponse.json({ error: "חסרים פרטים לתצוגה המקדימה" }, { status: 400 });
  }
  try {
    const plan = await previewShift({ userId: authed.user.id, roomKey, weekday, windowId, startDate });
    return NextResponse.json({
      startDate: plan.startDate,
      endDate: plan.endDate,
      priceAgorot: plan.priceAgorot,
      firstChargeAgorot: plan.firstChargeAgorot,
      months: plan.months,
      conflicts: plan.conflicts,
      occurrences: plan.occurrences.map((o) => ({
        date: o.date,
        month: o.month,
        startTime: o.startTime.toISOString(),
        endTime: o.endTime.toISOString(),
        priceAgorot: o.priceAgorot,
        skipReason: o.skipReason ?? null,
      })),
    });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
