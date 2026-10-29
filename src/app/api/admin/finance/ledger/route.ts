import { NextResponse } from "next/server";
import { adminRoute, dateParam } from "@/lib/finance/http";
import { getLedger } from "@/lib/finance/overview";

/** ספר תנועות מאוחד (תשלומים, החזרים, הסדרות חוב) עם סינון לפי לקוח, סוג, סטטוס וטווח תאריכים */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams;
    const rows = await getLedger({
      userId: q.get("userId") || undefined,
      q: q.get("q") || undefined,
      type: q.get("type") || undefined,
      status: q.get("status") || undefined,
      from: dateParam(q.get("from")),
      to: dateParam(q.get("to"), true),
    });
    return NextResponse.json({ rows });
  });
}
