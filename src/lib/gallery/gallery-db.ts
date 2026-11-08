import { prisma } from "@/lib/prisma";

export async function listGalleryImages() {
  return prisma.galleryImage.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function nextGallerySortOrder(): Promise<number> {
  const last = await prisma.galleryImage.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

/** שומר סדר חדש בטרנזקציה אחת. על הקורא לוודא קודם שהרשימה כוללת בדיוק את כל המזהים הקיימים */
export async function reorderGalleryImages(orderedIds: string[]): Promise<void> {
  await prisma.$transaction(
    orderedIds.map((id, index) => prisma.galleryImage.update({ where: { id }, data: { sortOrder: index } })),
  );
}
