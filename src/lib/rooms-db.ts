import { prisma } from "@/lib/prisma";
import { ROOM_SEED } from "@/lib/rooms";

/** מוודא שכל החדרים המוגדרים ב-ROOM_SEED קיימים בטבלה (יוצר רק חדרים חסרים, לא דורס מצב פעיל/מושבת) */
export async function ensureRooms() {
  const existing = await prisma.room.findMany({ select: { key: true } });
  const have = new Set(existing.map((r) => r.key));
  const missing = ROOM_SEED.filter((r) => !have.has(r.key));
  if (missing.length > 0) {
    await prisma.room.createMany({ data: missing, skipDuplicates: true });
  }
}
