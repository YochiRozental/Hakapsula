import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { getShiftFinance } from "@/lib/finance/overview";
import { getShiftsProvider } from "@/lib/shifts/gate";

/** חיובי משמרות שלא נגבו, משמרות בתקופת חסד ומשמרות מושעות, בתוך התמונה הכספית. ריק כשמודול המשמרות סגור */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    if (!getShiftsProvider()) return NextResponse.json({ enabled: false, charges: [], graceShifts: [], suspendedShifts: [] });
    return NextResponse.json({ enabled: true, ...(await getShiftFinance()) });
  });
}
