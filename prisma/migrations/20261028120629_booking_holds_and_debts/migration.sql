-- CreateEnum
CREATE TYPE "AppointmentPaymentStatus" AS ENUM ('NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUNDED', 'DEBT');

-- CreateEnum
CREATE TYPE "DebtStatus" AS ENUM ('OPEN', 'PAID', 'WAIVED');

-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" "AppointmentPaymentStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- CreateTable
CREATE TABLE "Debt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "amountAgorot" INTEGER NOT NULL,
    "status" "DebtStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Debt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockProviderRecord" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockProviderRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Debt_appointmentId_key" ON "Debt"("appointmentId");

-- CreateIndex
CREATE INDEX "Debt_userId_status_idx" ON "Debt"("userId", "status");

-- CreateIndex
CREATE INDEX "Appointment_status_holdExpiresAt_idx" ON "Appointment"("status", "holdExpiresAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- לכל הזמנה לכל היותר תשלום הזמנה אחד ממתין ואחד מוצלח (הגנה ברמת המסד מפני לחיצה כפולה וחיוב כפול)
CREATE UNIQUE INDEX "Payment_one_pending_booking_per_appointment" ON "Payment"("appointmentId") WHERE "purpose" = 'BOOKING' AND "status" = 'PENDING';
CREATE UNIQUE INDEX "Payment_one_succeeded_booking_per_appointment" ON "Payment"("appointmentId") WHERE "purpose" = 'BOOKING' AND "status" = 'SUCCEEDED';

-- החזקה חייבת תאריך פקיעה
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_hold_has_expiry" CHECK ("status" <> 'PENDING_PAYMENT' OR "holdExpiresAt" IS NOT NULL);
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_amountAgorot_positive" CHECK ("amountAgorot" > 0);
