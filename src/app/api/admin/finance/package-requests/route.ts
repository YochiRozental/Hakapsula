import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { listCancellationRequests } from "@/lib/finance/package-cancel";

export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const all = new URL(request.url).searchParams.get("status") === "ALL";
    return NextResponse.json({ requests: await listCancellationRequests(all ? "ALL" : "PENDING") });
  });
}
