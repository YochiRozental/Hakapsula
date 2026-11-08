import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { reorderGalleryImages } from "@/lib/gallery/gallery-db";

const reorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים לא תקינים" }, { status: 400 });
  }

  const { orderedIds } = parsed.data;
  const existing = await prisma.galleryImage.findMany({ select: { id: true } });
  const existingIds = new Set(existing.map((r) => r.id));

  const sameSet = orderedIds.length === existingIds.size && orderedIds.every((id) => existingIds.has(id));
  if (!sameSet) {
    return NextResponse.json({ error: "הרשימה שהתקבלה אינה תואמת את התמונות הקיימות" }, { status: 409 });
  }

  await reorderGalleryImages(orderedIds);
  return NextResponse.json({ ok: true });
}
