-- CreateEnum
CREATE TYPE "DebtSettlementKind" AS ENUM ('PAYMENT', 'WAIVER');

-- CreateEnum
CREATE TYPE "RefundReviewStatus" AS ENUM ('APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "DebtStatus" ADD VALUE 'IN_REVIEW';

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "paidAgorot" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "waivedAgorot" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "HoursPackage" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "PackageCancellationRequest" ADD COLUMN     "forfeitedMinutes" INTEGER,
ADD COLUMN     "refundAgorot" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundId" TEXT;

-- CreateTable
CREATE TABLE "DebtSettlement" (
    "id" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "kind" "DebtSettlementKind" NOT NULL,
    "amountAgorot" INTEGER NOT NULL,
    "method" TEXT,
    "paymentId" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundReview" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "status" "RefundReviewStatus" NOT NULL,
    "reason" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "adminId" TEXT,
    "userId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "paymentId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DebtSettlement_paymentId_key" ON "DebtSettlement"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtSettlement_idempotencyKey_key" ON "DebtSettlement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DebtSettlement_debtId_idx" ON "DebtSettlement"("debtId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundReview_appointmentId_key" ON "RefundReview"("appointmentId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PackageCancellationRequest_refundId_key" ON "PackageCancellationRequest"("refundId");

-- AddForeignKey
ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- חוב שנסגר לפני השלב הזה: מעדכנים את פירוט הסגירה כך שיעמוד באילוצים
UPDATE "Debt" SET "paidAgorot" = "amountAgorot" WHERE "status" = 'PAID';
UPDATE "Debt" SET "waivedAgorot" = "amountAgorot" WHERE "status" = 'WAIVED';

-- תקינות חובות: אין יתרה שלילית; חוב סגור סגור במלואו; חוב פתוח (OPEN/IN_REVIEW) עם יתרה חיובית.
-- (בלי להזכיר IN_REVIEW במפורש: ערך enum חדש אינו שמיש באותה טרנזקציה שבה נוסף)
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_amounts_nonnegative" CHECK ("paidAgorot" >= 0 AND "waivedAgorot" >= 0 AND "paidAgorot" + "waivedAgorot" <= "amountAgorot");
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_closed_is_settled" CHECK ("status" NOT IN ('PAID', 'WAIVED') OR "paidAgorot" + "waivedAgorot" = "amountAgorot");
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_open_has_balance" CHECK ("status" IN ('PAID', 'WAIVED') OR "paidAgorot" + "waivedAgorot" < "amountAgorot");
ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_amount_positive" CHECK ("amountAgorot" > 0);
ALTER TABLE "PackageCancellationRequest" ADD CONSTRAINT "PackageCancellationRequest_refund_nonnegative" CHECK ("refundAgorot" >= 0);

-- יומן ביקורת: נוספות בלבד. עדכון ומחיקה נחסמים ברמת המסד (גם מול קוד אפליקציה שגוי)
CREATE FUNCTION "AuditLog_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_no_update_delete" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "AuditLog_append_only"();
