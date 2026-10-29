import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { settleDebtExternal } from "@/lib/finance/debts";

/**
 * הסדרת חוב (מלאה או חלקית) בתשלום שהתקבל מחוץ למערכת. נדרשים: סכום, אסמכתה, ואישור מפורש שהתשלום התקבל.
 * לחיצה על כפתור אינה מספיקה: ללא אסמכתה ואישור הבקשה נדחית. הכרטיס השמור של הלקוח אינו מחויב כאן
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const body = await readJson(request);
    const res = await settleDebtExternal({
      debtId: (await params).id,
      adminId: admin.id,
      amountAgorot: body.amountAgorot,
      reference: body.reference,
      confirmedExternalPayment: body.confirmedExternalPayment,
      note: body.note,
      clientKey: body.clientKey,
    });
    return NextResponse.json({ debtId: res.debt.id, status: res.debt.status, paidAgorot: res.debt.paidAgorot, waivedAgorot: res.debt.waivedAgorot, replayed: res.replayed });
  });
}
