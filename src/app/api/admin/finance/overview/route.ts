import { NextResponse } from "next/server";
import { adminRoute, dateParam } from "@/lib/finance/http";
import { getFinanceOverview } from "@/lib/finance/overview";
import { getShiftsProvider } from "@/lib/shifts/gate";

/** תמונת מצב כספית. סכומים באגורות; הטווח חל על תנועות. חיובי משמרות נכללים רק כשמודול המשמרות פתוח */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams;
    const overview = await getFinanceOverview({ from: dateParam(q.get("from")), to: dateParam(q.get("to"), true) }, getShiftsProvider() !== null);
    return NextResponse.json(overview);
  });
}
