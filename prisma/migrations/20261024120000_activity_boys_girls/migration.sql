-- מסלולי הפעילות הופכים ל-BOYS / GIRLS (במקום GENERAL / THERAPY / WORKSHOP).
-- חלונות קיימים נשמרים; המסלול נקבע לפי יום בשבוע (ראשון, שלישי, חמישי — בנות; שני, רביעי, שישי — בנים).
-- ימי שבת (קיימים כשורות ישנות בלבד, ולא בשימוש) מקבלים BOYS.
CREATE TYPE "ActivityType_new" AS ENUM ('BOYS', 'GIRLS');

ALTER TABLE "OpeningWindow" ALTER COLUMN "activity" DROP DEFAULT;

ALTER TABLE "OpeningWindow"
  ALTER COLUMN "activity" TYPE "ActivityType_new"
  USING (
    CASE
      WHEN COALESCE("weekday", EXTRACT(DOW FROM "date"::date)::int) IN (0, 2, 4) THEN 'GIRLS'
      ELSE 'BOYS'
    END
  )::"ActivityType_new";

DROP TYPE "ActivityType";
ALTER TYPE "ActivityType_new" RENAME TO "ActivityType";

ALTER TABLE "OpeningWindow" ALTER COLUMN "activity" SET DEFAULT 'GIRLS';
