import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getBalanceView } from "@/lib/payments/views";
import { errorResponse, getFlowProvider, notFound } from "@/lib/payments/flow";

/** יתרת הדקות של המשתמש המחובר: חבילות וזיכויים בתוקף, חבילות שפג תוקפן בנפרד, ובקשות ביטול. מחזיר רק את נתוני המשתמש עצמו */
export async function GET() {
  if (!getFlowProvider()) return notFound();
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  try {
    return NextResponse.json(await getBalanceView(session.user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
