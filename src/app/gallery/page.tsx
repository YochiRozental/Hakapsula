import { BrandHeader, EmptyState } from "@/components/ui";
import { GalleryGrid } from "@/components/gallery/gallery-grid";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const images = await prisma.galleryImage.findMany({
    orderBy: { sortOrder: "asc" },
    select: { id: true, url: true, width: true, height: true, title: true, description: true },
  });

  return (
    <div className="max-w-6xl mx-auto">
      <BrandHeader eyebrow="הקפסולה" title="גלריית הקליניקות" subtitle="הצצה למרחבים שלנו" />

      {images.length === 0 ? (
        <EmptyState icon="image">עדיין לא הועלו תמונות לגלריה. חזרו לבקר בקרוב.</EmptyState>
      ) : (
        <GalleryGrid images={images} />
      )}
    </div>
  );
}
