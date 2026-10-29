import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/finance/http";
import { setCustomerBlock } from "@/lib/finance/blocks";

/** חסימה (blocked=true) או שחרור חסימה (false) של לקוח מהזמנות עתידיות. נדרשת סיבה; מתועד ביומן הביקורת */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const body = await readJson(request);
    return NextResponse.json(await setCustomerBlock({ adminId: admin.id, userId: (await params).id, blocked: body.blocked === true, reason: body.reason }));
  });
}
