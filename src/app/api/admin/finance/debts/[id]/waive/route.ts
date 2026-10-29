import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { waiveDebt } from "@/lib/finance/debts";

/** ויתור על חוב (מלא או חלקי) עם סיבה מתועדת. החוב נשאר ברשומות כסגור בוויתור; לא נמחק */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const body = await readJson(request);
    const res = await waiveDebt({ debtId: (await params).id, adminId: admin.id, amountAgorot: body.amountAgorot, reason: body.reason, clientKey: body.clientKey });
    return NextResponse.json({ debtId: res.debt.id, status: res.debt.status, paidAgorot: res.debt.paidAgorot, waivedAgorot: res.debt.waivedAgorot, replayed: res.replayed });
  });
}
