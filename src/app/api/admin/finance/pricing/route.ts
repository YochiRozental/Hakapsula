import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminRoute, readJson } from "@/lib/finance/http";
import { getRegularPricing, saveRegularPricing, validateRegularPricingInput, type RegularPricingDef } from "@/lib/payments/pricing-db";

async function withUpdatedByName(pricing: RegularPricingDef) {
  const updatedByName = pricing.updatedById
    ? (await prisma.user.findUnique({ where: { id: pricing.updatedById }, select: { name: true } }))?.name ?? null
    : null;
  return { ...pricing, updatedByName };
}

/** מחיר שעה בודדת וכרטיסיות 5/10/20 שעות (לתצוגת הממשק). מחירי המשמרות החודשיות מנוהלים ב-/api/admin/shifts/windows */
export async function GET(request: Request) {
  return adminRoute(request, { write: false }, async () => {
    const pricing = await withUpdatedByName(await getRegularPricing());
    return NextResponse.json({ pricing });
  });
}

/** שמירת התמחור הרגיל. חל מיידית על רכישות/הזמנות חדשות; תשלומים וחבילות קיימים אינם מושפעים */
export async function PUT(request: Request) {
  return adminRoute(request, { write: true }, async ({ admin }) => {
    const body = await readJson(request);
    const input = validateRegularPricingInput(body);
    const pricing = await withUpdatedByName(await saveRegularPricing({ adminId: admin.id, input }));
    return NextResponse.json({ pricing });
  });
}
