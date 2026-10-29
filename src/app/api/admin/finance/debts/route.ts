import { NextResponse } from "next/server";
import { adminRoute, dateParam } from "@/lib/finance/http";
import { listDebts } from "@/lib/finance/debts";

/** כל החובות, עם סינון לפי לקוח, סטטוס, תאריך וסכום (באגורות) */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams;
    const num = (k: string) => (q.get(k) && Number.isInteger(Number(q.get(k))) ? Number(q.get(k)) : undefined);
    const debts = await listDebts({
      userId: q.get("userId") || undefined,
      q: q.get("q") || undefined,
      status: ["OPEN", "IN_REVIEW", "PAID", "WAIVED"].includes(q.get("status") ?? "") ? q.get("status")! : undefined,
      from: dateParam(q.get("from")),
      to: dateParam(q.get("to"), true),
      minAgorot: num("min"),
      maxAgorot: num("max"),
    });
    return NextResponse.json({ debts });
  });
}
