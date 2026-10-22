-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('GENERAL', 'THERAPY', 'WORKSHOP');

-- AlterTable: חלונות קיימים הופכים ל-GENERAL (פתוחים לכל מסלולי ההזמנה), כך שההתנהגות הקיימת נשמרת
ALTER TABLE "OpeningWindow" ADD COLUMN "activity" "ActivityType" NOT NULL DEFAULT 'GENERAL';
