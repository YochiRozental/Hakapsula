import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/finance/http";
import { searchCustomers } from "@/lib/finance/overview";

export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ customers: await searchCustomers(q) });
  });
}
