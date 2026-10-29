import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";
import { getPaymentHistory } from "@/lib/payments/views";

/** היסטוריית תשלומים וניצול של המשתמש המחובר בלבד. קריאה בלבד */
export async function GET() {
  if (!getFlowProvider()) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  try {
    return NextResponse.json({ entries: await getPaymentHistory(session.user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
