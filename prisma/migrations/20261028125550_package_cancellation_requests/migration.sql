-- CreateEnum
CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "PackageCancellationRequest" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "status" "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,

    CONSTRAINT "PackageCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackageCancellationRequest_packageId_status_idx" ON "PackageCancellationRequest"("packageId", "status");

-- CreateIndex
CREATE INDEX "PackageCancellationRequest_userId_createdAt_idx" ON "PackageCancellationRequest"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PackageCancellationRequest" ADD CONSTRAINT "PackageCancellationRequest_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "HoursPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageCancellationRequest" ADD CONSTRAINT "PackageCancellationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- לכל חבילה לכל היותר בקשת ביטול פתוחה אחת (מניעת בקשות כפולות גם תחת בקשות מקבילות)
CREATE UNIQUE INDEX "PackageCancellationRequest_one_pending_per_package" ON "PackageCancellationRequest"("packageId") WHERE "status" = 'PENDING';
