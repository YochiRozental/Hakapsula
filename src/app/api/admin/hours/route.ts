import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { loadWindows } from "@/lib/opening-hours-db";

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  return NextResponse.json(await loadWindows());
}
