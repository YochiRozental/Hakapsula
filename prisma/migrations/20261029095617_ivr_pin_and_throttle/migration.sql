-- CreateEnum
CREATE TYPE "IvrPinEventKind" AS ENUM ('SET', 'CHANGED', 'RESET', 'MIGRATED_LEGACY', 'BLOCKED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ivrPinHash" TEXT,
ADD COLUMN     "ivrPinUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PinThrottle" (
    "scope" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "blockedUntil" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinThrottle_pkey" PRIMARY KEY ("scope","subject")
);

-- CreateTable
CREATE TABLE "IvrPinEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "IvrPinEventKind" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IvrPinEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IvrPinEvent_userId_createdAt_idx" ON "IvrPinEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "IvrPinEvent" ADD CONSTRAINT "IvrPinEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- בכוונה אין כאן העתקת נתונים: ivrPinHash נשאר NULL לכל המשתמשים הקיימים. passwordHash אינו נוגע.
-- העברה של קודים טלפוניים ותיקים נעשית רק בכלי נפרד, מבוקר ומאושר (scripts/migrate-legacy-ivr-pins.ts)
ALTER TABLE "PinThrottle" ADD CONSTRAINT "PinThrottle_failedCount_nonnegative" CHECK ("failedCount" >= 0);
