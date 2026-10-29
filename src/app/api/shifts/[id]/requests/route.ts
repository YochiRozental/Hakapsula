import { NextResponse } from "next/server";
import { createShiftRequest } from "@/lib/shifts/lifecycle";
import { gateProvider, int, mutationGuard, notFound, readJson, requireClient, shiftErrorResponse, str } from "@/lib/shifts/http";

/**
 * בקשת שינוי או ביטול משמרת. הבקשה רק נרשמת: המשמרת, המופעים והחיובים לא משתנים עד אישור מנהל. משמרת של אחר מוסתרת (404).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!gateProvider()) return notFound();
  const blocked = mutationGuard(request);
  if (blocked) return blocked;
  const authed = await requireClient();
  if (authed.response) return authed.response;

  const { id } = await params;
  const body = await readJson(request);
  const kind = body?.kind === "CANCEL" ? "CANCEL" : body?.kind === "CHANGE" ? "CHANGE" : null;
  if (!kind) return NextResponse.json({ error: "סוג בקשה לא תקין" }, { status: 400 });
  const proposed = body?.proposed && typeof body.proposed === "object" ? (body.proposed as Record<string, unknown>) : undefined;

  try {
    const created = await createShiftRequest({
      userId: authed.user.id,
      shiftId: id,
      kind,
      reason: str(body?.reason),
      proposed: proposed ? { roomKey: str(proposed.roomKey), weekday: int(proposed.weekday), windowId: str(proposed.windowId) } : undefined,
      requestedFrom: str(body?.requestedFrom),
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return shiftErrorResponse(err);
  }
}
