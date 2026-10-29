-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "paidCashAgorot" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidFromBalanceMinutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PackageUsage" ADD COLUMN     "convertedToCreditId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "packageHours" INTEGER,
ADD COLUMN     "packageMinutes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditUsage" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "kind" "PackageUsageKind" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "appointmentId" TEXT,
    "convertedToCreditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditUsage_creditId_idx" ON "CreditUsage"("creditId");

-- CreateIndex
CREATE INDEX "CreditUsage_appointmentId_idx" ON "CreditUsage"("appointmentId");

-- AddForeignKey
ALTER TABLE "HoursPackage" ADD CONSTRAINT "HoursPackage_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditUsage" ADD CONSTRAINT "CreditUsage_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "Credit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ניצול/החזרה של אותו מקור עבור אותה הזמנה נרשם פעם אחת בלבד (הגנת מסד מפני ניצול והחזרה כפולים)
CREATE UNIQUE INDEX "PackageUsage_one_consume_per_appointment" ON "PackageUsage"("packageId", "appointmentId") WHERE "kind" = 'CONSUME' AND "appointmentId" IS NOT NULL;
CREATE UNIQUE INDEX "PackageUsage_one_restore_per_appointment" ON "PackageUsage"("packageId", "appointmentId") WHERE "kind" = 'RESTORE' AND "appointmentId" IS NOT NULL;
CREATE UNIQUE INDEX "CreditUsage_one_consume_per_appointment" ON "CreditUsage"("creditId", "appointmentId") WHERE "kind" = 'CONSUME' AND "appointmentId" IS NOT NULL;
CREATE UNIQUE INDEX "CreditUsage_one_restore_per_appointment" ON "CreditUsage"("creditId", "appointmentId") WHERE "kind" = 'RESTORE' AND "appointmentId" IS NOT NULL;

-- אילוצי תקינות
ALTER TABLE "CreditUsage" ADD CONSTRAINT "CreditUsage_minutes_positive" CHECK ("minutes" > 0);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_paid_split_nonnegative" CHECK ("paidFromBalanceMinutes" >= 0 AND "paidCashAgorot" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageMinutes_nonnegative" CHECK ("packageMinutes" >= 0);
