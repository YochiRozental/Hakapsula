-- CreateTable
CREATE TABLE "RegularPricing" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "hourlyAgorot" INTEGER NOT NULL,
    "package5Agorot" INTEGER NOT NULL,
    "package10Agorot" INTEGER NOT NULL,
    "package20Agorot" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "RegularPricing_pkey" PRIMARY KEY ("id")
);

-- Seed: ערכי התמחור הנוכחיים (שעה בודדת 75 ₪, כרטיסיות 5/10/20 שעות). אתחול בלבד, אינו משנה תשלומים/חבילות קיימים
INSERT INTO "RegularPricing" ("id", "hourlyAgorot", "package5Agorot", "package10Agorot", "package20Agorot", "updatedAt") VALUES
  ('default', 7500, 30000, 55000, 100000, CURRENT_TIMESTAMP);
