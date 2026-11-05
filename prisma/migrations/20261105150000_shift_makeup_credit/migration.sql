-- AlterTable: קישור מפגש שדולג (סגירה ביוזמת ההנהלה) לזיכוי הדקות שניתן עבורו. עמודה חדשה nullable, בלי שינוי בנתונים קיימים
ALTER TABLE "ShiftOccurrence" ADD COLUMN     "makeupCreditId" TEXT;

-- CreateIndex: זיכוי אחד לכל מפגש לכל היותר (מונע מתן כפול)
CREATE UNIQUE INDEX "ShiftOccurrence_makeupCreditId_key" ON "ShiftOccurrence"("makeupCreditId");
