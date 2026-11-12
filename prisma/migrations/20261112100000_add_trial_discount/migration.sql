-- AlterTable: הטבת 25% להזמנה ראשונה בכסף. שדות אופציונליים בלבד — ברירת המחדל לכל המשתמשים הקיימים היא NULL,
-- כלומר כולם זכאים מהיום (אין "השלמה לאחור" לפי היסטוריית הזמנות; ראו ההחלטה העסקית בדוח)
ALTER TABLE "User" ADD COLUMN "trialDiscountUsedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "trialDiscountReservedAppointmentId" TEXT;

-- AlterTable: כמה מתוך amountAgorot הוא הנחת ההזמנה הראשונה. ברירת מחדל 0 לתשלומים קיימים (לא היתה הנחה)
ALTER TABLE "Payment" ADD COLUMN "discountAgorot" INTEGER NOT NULL DEFAULT 0;
