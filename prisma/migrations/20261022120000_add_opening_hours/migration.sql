-- CreateTable
CREATE TABLE "OpeningWindow" (
    "id" TEXT NOT NULL,
    "weekday" INTEGER,
    "date" TEXT,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningWindow_active_weekday_idx" ON "OpeningWindow"("active", "weekday");

-- CreateIndex
CREATE INDEX "OpeningWindow_active_date_idx" ON "OpeningWindow"("active", "date");
