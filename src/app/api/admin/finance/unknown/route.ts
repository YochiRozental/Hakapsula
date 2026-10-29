import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { listUnknown } from "@/lib/finance/unknown";
import { getShiftsProvider } from "@/lib/shifts/gate";

/** תור הבירור: תשלומים תקועים, החזרים שמצבם לא ידוע וחיובי משמרת לא ידועים */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => NextResponse.json(await listUnknown(new Date(), getShiftsProvider() !== null)));
}
