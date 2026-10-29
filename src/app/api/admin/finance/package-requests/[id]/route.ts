import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { decideCancellationRequest } from "@/lib/finance/package-cancel";

/**
 * החלטה בבקשת ביטול חבילה. אישור מאפס את היתרה (אין ניצול נוסף), ואם נקבע refundAgorot (אגורות, בהחלטת מנהל בלבד, עד מה ששולם
 * בפועל פחות החזרים קודמים) מבוצע החזר דרך שכבת הספק. דחייה משאירה את החבילה פעילה. סיבה חובה
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin, provider }) => {
    const b = await readJson(request);
    const res = await decideCancellationRequest({ requestId: (await params).id, adminId: admin.id, provider, decision: b.decision, reason: b.reason, refundAgorot: b.refundAgorot });
    return NextResponse.json(res, { status: res.refundStatus === "UNKNOWN" ? 202 : 200 });
  });
}
