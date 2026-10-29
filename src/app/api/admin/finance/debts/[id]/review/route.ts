import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { setDebtReview } from "@/lib/finance/debts";

/** העברת חוב לבירור (inReview=true) או החזרתו לפתוח (false). נדרשת הערה */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const body = await readJson(request);
    const debt = await setDebtReview({ debtId: (await params).id, adminId: admin.id, inReview: body.inReview === true, note: body.note });
    return NextResponse.json({ debtId: debt.id, status: debt.status });
  });
}
