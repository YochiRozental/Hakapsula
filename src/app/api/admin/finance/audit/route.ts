import { NextResponse } from "next/server";
import { adminRoute, dateParam } from "@/lib/finance/http";
import { listAudit } from "@/lib/finance/audit";

/** קריאה בלבד: אין נתיב לעדכון או מחיקה של רשומות ביקורת (וגם טריגר במסד חוסם זאת) */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams;
    const entries = await listAudit({
      action: q.get("action") || undefined,
      userId: q.get("userId") || undefined,
      entityType: q.get("entityType") || undefined,
      entityId: q.get("entityId") || undefined,
      from: dateParam(q.get("from")),
      to: dateParam(q.get("to"), true),
      take: Number(q.get("take")) || 100,
    });
    return NextResponse.json({ entries });
  });
}
