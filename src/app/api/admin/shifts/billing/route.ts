import { NextResponse } from "next/server";
import { runMonthlyShiftBilling } from "@/lib/shifts/billing";
import { gateProvider, mutationGuard, notFound, requireAdminUser, shiftErrorResponse } from "@/lib/shifts/http";

/**
 * הרצה ידנית של החיוב החודשי (לפיתוח ולבירור). אותה פונקציה בדיוק שה-Cron מריץ, ולכן אידמפוטנטית: הרצה כפולה אינה מחייבת
 * פעמיים. פעילה רק כשהשער פתוח (ספק Mock בסביבת sandbox מקומית); מנהל בלבד
 */
export async function POST(request: Request) {
  const provider = gateProvider();
  if (!provider) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const admin = await requireAdminUser();
  if (admin.response) return admin.response;
  try {
    return NextResponse.json(await runMonthlyShiftBilling({ provider, trigger: "admin-manual" }));
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
