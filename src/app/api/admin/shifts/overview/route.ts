import { NextResponse } from "next/server";
import { listEligibility, listPendingShiftRequests, recentCronRuns } from "@/lib/shifts/views";
import { gateProvider, notFound, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/** תמונת מצב למנהל: בקשות פתוחות, לקוחות זכאים (או תוצאות חיפוש לקוח לאישור זכאות), והרצות חיוב אחרונות */
export async function GET(request: Request) {
  if (!gateProvider()) return notFound();
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  try {
    const q = new URL(request.url).searchParams.get("q") || undefined;
    const [requests, eligibility, runs] = await Promise.all([listPendingShiftRequests(), listEligibility(q), recentCronRuns(8)]);
    return NextResponse.json({ requests, eligibility, runs });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
