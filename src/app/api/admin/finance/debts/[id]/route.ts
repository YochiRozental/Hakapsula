import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { getDebt } from "@/lib/finance/debts";
import { FinanceError } from "@/lib/finance/errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: false }, async () => {
    const debt = await getDebt((await params).id);
    if (!debt) throw new FinanceError("החוב לא נמצא", "NOT_FOUND");
    return NextResponse.json(debt);
  });
}
