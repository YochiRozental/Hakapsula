-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "monthlyPriceAgorot" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ShiftWindow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "monthlyPriceAgorot" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftWindow_pkey" PRIMARY KEY ("id")
);

-- Seed: ארבע המשבצות הראשוניות (מחירון חודשי כולל מע"מ). נשמרים המזהים הישנים כדי שמשמרות קיימות ימשיכו להצביע עליהן
INSERT INTO "ShiftWindow" ("id", "name", "startMinutes", "endMinutes", "monthlyPriceAgorot", "active", "sortOrder", "updatedAt") VALUES
  ('MORNING',   'בוקר',         420,  660, 48000, true, 1, CURRENT_TIMESTAMP),
  ('NOON',      'צהריים',       660,  900, 52500, true, 2, CURRENT_TIMESTAMP),
  ('AFTERNOON', 'אחר הצהריים',  900, 1140, 60000, true, 3, CURRENT_TIMESTAMP),
  ('EVENING',   'ערב',         1140, 1380, 50000, true, 4, CURRENT_TIMESTAMP);
