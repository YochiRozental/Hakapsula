-- CreateEnum
CREATE TYPE "ShiftPaymentMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ShiftMakeupStatus" AS ENUM ('OWED', 'ARRANGED', 'WAIVED');

-- AlterTable: עמודות חדשות בלבד, כולן עם ברירת מחדל או nullable. שום נתון קיים אינו משתנה
ALTER TABLE "Shift" ADD COLUMN     "paymentMode" "ShiftPaymentMode" NOT NULL DEFAULT 'AUTO';

-- AlterTable
ALTER TABLE "ShiftCharge" ADD COLUMN     "dueDate" TEXT,
ADD COLUMN     "manualAmountAgorot" INTEGER,
ADD COLUMN     "manualPaidOn" TEXT,
ADD COLUMN     "manualReference" TEXT;

-- AlterTable
ALTER TABLE "ShiftOccurrence" ADD COLUMN     "makeupNote" TEXT,
ADD COLUMN     "makeupStatus" "ShiftMakeupStatus",
ADD COLUMN     "makeupUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "makeupUpdatedById" TEXT;

-- משבצת הערב נכנסת לשעות הפעילות החדשות (עד 22:00). מעדכנים רק אם היא עדיין בערך שנזרע (19:00-23:00), כדי לא לדרוס עריכת מנהל
UPDATE "ShiftWindow" SET "endMinutes" = 1320, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'EVENING' AND "startMinutes" = 1140 AND "endMinutes" = 1380;
