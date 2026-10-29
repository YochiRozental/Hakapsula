-- CreateEnum
CREATE TYPE "PaymentAuthorizationAction" AS ENUM ('CONFIRM_BALANCE', 'PAY_CARD');

-- CreateTable
CREATE TABLE "PaymentAuthorization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "action" "PaymentAuthorizationAction" NOT NULL,
    "amountAgorot" INTEGER NOT NULL,
    "packageMinutes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAuthorization_userId_createdAt_idx" ON "PaymentAuthorization"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAuthorization_appointmentId_idx" ON "PaymentAuthorization"("appointmentId");

-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- הרשאה תקפה היא לא-נצרכת בלבד; סכומים לא שליליים
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_amounts_nonnegative" CHECK ("amountAgorot" >= 0 AND "packageMinutes" >= 0);
