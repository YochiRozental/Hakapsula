-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "ShiftOccurrenceStatus" AS ENUM ('SCHEDULED', 'SKIPPED_CLOSED_DAY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShiftChargeStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'UNKNOWN', 'WAIVED');

-- CreateEnum
CREATE TYPE "ShiftRequestKind" AS ENUM ('CHANGE', 'CANCEL');

-- CreateEnum
CREATE TYPE "ShiftRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- AlterEnum
ALTER TYPE "BookingSource" ADD VALUE 'SHIFT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "canBookShifts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shiftEligibilityUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "shiftEligibilityUpdatedById" TEXT;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "windowId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethodId" TEXT,
    "occurrencePriceAgorot" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "resumedAt" TIMESTAMP(3),
    "resumedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftOccurrence" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "ShiftOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "statusNote" TEXT,
    "priceAgorot" INTEGER NOT NULL,
    "appointmentId" TEXT,
    "refundedAgorot" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftCharge" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amountAgorot" INTEGER NOT NULL,
    "occurrenceCount" INTEGER NOT NULL,
    "isFirst" BOOLEAN NOT NULL DEFAULT false,
    "status" "ShiftChargeStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "failureCode" TEXT,
    "graceUntil" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "refundedAgorot" INTEGER NOT NULL DEFAULT 0,
    "resolvedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftChangeRequest" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ShiftRequestKind" NOT NULL,
    "status" "ShiftRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "proposedRoomKey" TEXT,
    "proposedWeekday" INTEGER,
    "proposedWindowId" TEXT,
    "requestedFrom" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "appliedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_idempotencyKey_key" ON "Shift"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Shift_userId_status_idx" ON "Shift"("userId", "status");

-- CreateIndex
CREATE INDEX "Shift_status_endDate_idx" ON "Shift"("status", "endDate");

-- CreateIndex
CREATE INDEX "Shift_roomId_weekday_idx" ON "Shift"("roomId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftOccurrence_appointmentId_key" ON "ShiftOccurrence"("appointmentId");

-- CreateIndex
CREATE INDEX "ShiftOccurrence_shiftId_month_status_idx" ON "ShiftOccurrence"("shiftId", "month", "status");

-- CreateIndex
CREATE INDEX "ShiftOccurrence_date_status_idx" ON "ShiftOccurrence"("date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftOccurrence_shiftId_date_key" ON "ShiftOccurrence"("shiftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftCharge_paymentId_key" ON "ShiftCharge"("paymentId");

-- CreateIndex
CREATE INDEX "ShiftCharge_status_graceUntil_idx" ON "ShiftCharge"("status", "graceUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftCharge_shiftId_month_key" ON "ShiftCharge"("shiftId", "month");

-- CreateIndex
CREATE INDEX "ShiftChangeRequest_shiftId_status_idx" ON "ShiftChangeRequest"("shiftId", "status");

-- CreateIndex
CREATE INDEX "ShiftChangeRequest_status_createdAt_idx" ON "ShiftChangeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CronRun_job_startedAt_idx" ON "CronRun"("job", "startedAt");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOccurrence" ADD CONSTRAINT "ShiftOccurrence_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOccurrence" ADD CONSTRAINT "ShiftOccurrence_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftCharge" ADD CONSTRAINT "ShiftCharge_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftCharge" ADD CONSTRAINT "ShiftCharge_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftChangeRequest" ADD CONSTRAINT "ShiftChangeRequest_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftChangeRequest" ADD CONSTRAINT "ShiftChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- בקשת שינוי/ביטול פתוחה אחת לכל משמרת (גם תחת בקשות מקבילות)
CREATE UNIQUE INDEX "ShiftChangeRequest_one_pending_per_shift" ON "ShiftChangeRequest"("shiftId") WHERE "status" = 'PENDING';

-- ריצה אחת של עבודה מתוזמנת בכל רגע: שורת RUNNING אחת לכל עבודה
CREATE UNIQUE INDEX "CronRun_one_running_per_job" ON "CronRun"("job") WHERE "status" = 'RUNNING';

-- תקינות נתונים
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_weekday_open_days" CHECK ("weekday" BETWEEN 0 AND 5);
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_price_nonnegative" CHECK ("occurrencePriceAgorot" >= 0);
ALTER TABLE "ShiftOccurrence" ADD CONSTRAINT "ShiftOccurrence_price_nonnegative" CHECK ("priceAgorot" >= 0 AND "refundedAgorot" >= 0);
ALTER TABLE "ShiftCharge" ADD CONSTRAINT "ShiftCharge_amounts_nonnegative" CHECK ("amountAgorot" >= 0 AND "occurrenceCount" >= 0 AND "refundedAgorot" >= 0 AND "attempt" >= 0);
