import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { listGalleryImages, nextGallerySortOrder } from "@/lib/gallery/gallery-db";
import { uploadImageToCloudinary, deleteImageFromCloudinary } from "@/lib/gallery/cloudinary";
import { detectRealImageType, MAX_IMAGE_BYTES } from "@/lib/gallery/validate-image";

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const images = await listGalleryImages();
  return NextResponse.json(images);
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) {
    return NextResponse.json({ error: "לא נבחר קובץ" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "הקובץ ריק" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: `הקובץ גדול מהמותר (עד ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB)` }, { status: 400 });
  }

  const titleRaw = form.get("title");
  const descriptionRaw = form.get("description");
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim().slice(0, 120) : null;
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim() ? descriptionRaw.trim().slice(0, 500) : null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const realType = detectRealImageType(buffer);
  if (!realType) {
    return NextResponse.json({ error: "הקובץ אינו תמונה תקינה (JPEG / PNG / GIF / WEBP)" }, { status: 400 });
  }

  let uploaded;
  try {
    uploaded = await uploadImageToCloudinary(buffer, file.name || "image");
  } catch (error) {
    console.error("[gallery] Cloudinary upload failed:", error);
    return NextResponse.json({ error: "העלאת התמונה לאחסון נכשלה. נסו שוב" }, { status: 502 });
  }

  try {
    const sortOrder = await nextGallerySortOrder();
    const image = await prisma.galleryImage.create({
      data: {
        publicId: uploaded.publicId,
        url: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
        title,
        description,
        sortOrder,
      },
    });
    return NextResponse.json(image, { status: 201 });
  } catch (error) {
    // התמונה כבר הועלתה ל-Cloudinary אך לא נשמרה ברשומה — מנקים כדי לא להשאיר קובץ יתום
    console.error("[gallery] DB write failed after upload, rolling back Cloudinary asset:", error);
    try {
      await deleteImageFromCloudinary(uploaded.publicId);
    } catch (cleanupError) {
      console.error("[gallery] cleanup after failed DB write also failed:", cleanupError);
    }
    return NextResponse.json({ error: "שמירת נתוני התמונה נכשלה" }, { status: 500 });
  }
}
