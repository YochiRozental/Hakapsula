import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { deleteImageFromCloudinary } from "@/lib/gallery/cloudinary";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await params;
  const image = await prisma.galleryImage.findUnique({ where: { id } });
  if (!image) return NextResponse.json({ error: "התמונה לא נמצאה" }, { status: 404 });

  // מוחקים מהאחסון לפני מחיקת הרשומה: אם זה נכשל, הרשומה נשארת ואין תמונה "רפאים" בלי קובץ מגובה
  try {
    await deleteImageFromCloudinary(image.publicId);
  } catch (error) {
    console.error("[gallery] delete from Cloudinary failed:", error);
    return NextResponse.json({ error: "מחיקת התמונה מהאחסון נכשלה. נסו שוב" }, { status: 502 });
  }

  try {
    await prisma.galleryImage.delete({ where: { id } });
  } catch {
    // נמחקה כבר ע"י בקשה מקבילה — האחסון כבר פנוי, אין בעיה
  }
  return NextResponse.json({ ok: true });
}
