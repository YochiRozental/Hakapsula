/**
 * תמחור, חבילות ומשמרות. פונקציות טהורות בלבד (ללא מסד נתונים) — המחירים עצמם (שעה בודדת וכרטיסיות) הם פרמטר
 * שהקורא מעביר, ומקורם היחיד הוא RegularPricing במסד (ראו pricing-db.ts). אין כאן קבועי מחיר קשיחים, כדי שלא
 * תהיה כפילות בין מחיר בקוד למחיר במסד. הכול באגורות שלמות; משכי זמן בדקות, בקפיצות של רבע שעה.
 */

export const SLOT_MINUTES = 15;

export function assertQuarterHours(minutes: number) {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % SLOT_MINUTES !== 0) {
    throw new RangeError(`משך חייב להיות מכפלה חיובית של ${SLOT_MINUTES} דקות`);
  }
}

/** מחיר רגיל להזמנה לפי משך בדקות ומחיר שעה (באגורות) נוכחי. מעוגל לאגורה הקרובה */
export function regularPriceAgorot(minutes: number, hourlyAgorot: number): number {
  assertQuarterHours(minutes);
  return Math.round((minutes * hourlyAgorot) / 60);
}

// ---- חבילות שעות ----
// מחירי 5/10/20 השעות נשמרים ב-RegularPricing (ראו pricing-db.ts: hoursPackageOptions). חבילות שהוסרו מהמכירה
// (אך עדיין נתמכות במלואן ליתרות קיימות, כי אינן תלויות ברשימה הזו בכלל — ראו HoursPackage.pricePaidAgorot/
// minutesRemaining) מתועדות ב-LEGACY_HOURS_PACKAGES בלבד.

export interface HoursPackageOption {
  hours: number;
  priceAgorot: number;
}

/** הוסרו מהמכירה (לא ניתנות לרכישה חדשה דרך findHoursPackage). תיעוד בלבד — יתרות שכבר נרכשו אינן תלויות כאן */
export const LEGACY_HOURS_PACKAGES = [
  { hours: 50, priceAgorot: 143000 },
  { hours: 100, priceAgorot: 275600 },
] as const;

export function findHoursPackage(hours: number, options: readonly HoursPackageOption[]): HoursPackageOption | undefined {
  return options.find((p) => p.hours === hours);
}

export function packageMinutes(hours: number): number {
  return hours * 60;
}

/** כמה נחסך בחבילה לעומת מחיר רגיל לאותן שעות, לפי מחיר השעה הנוכחי */
export function packageSavingsAgorot(option: HoursPackageOption, hourlyAgorot: number): number {
  return regularPriceAgorot(packageMinutes(option.hours), hourlyAgorot) - option.priceAgorot;
}

/** תוקף חבילה: שנה מיום הרכישה. 29 בפברואר נחתך ל-28 בפברואר בשנה שאינה מעוברת */
export function packageExpiry(purchasedAt: Date): Date {
  const expiry = new Date(purchasedAt.getTime());
  const month = expiry.getUTCMonth();
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  if (expiry.getUTCMonth() !== month) {
    expiry.setUTCDate(0); // גלישה לחודש הבא -> היום האחרון של פברואר
  }
  return expiry;
}

export interface PackageBalance {
  id: string;
  expiresAt: Date;
  minutesRemaining: number;
}

export interface PackageAllocation {
  packageId: string;
  minutes: number;
}

export interface PackageAllocationResult {
  allocations: PackageAllocation[];
  /** דקות שהיתרות לא כיסו (לתשלום רגיל) */
  shortfallMinutes: number;
}

/**
 * ניצול יתרות לפי דקות: החבילה שפוקעת ראשונה מנוצלת ראשונה. חבילה שפגה (או פוקעת ברגע זה) לא משתתפת.
 * הפונקציה לא משנה את הקלט; היא רק מחשבת הקצאה. הנעילה והעדכון במסד שייכים לשלב הבא.
 */
export function allocatePackageMinutes(
  packages: PackageBalance[],
  minutesNeeded: number,
  now: Date
): PackageAllocationResult {
  if (!Number.isInteger(minutesNeeded) || minutesNeeded < 0) {
    throw new RangeError("מספר הדקות חייב להיות שלם ולא שלילי");
  }
  const usable = packages
    .filter((p) => p.expiresAt.getTime() > now.getTime() && p.minutesRemaining > 0)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id));

  const allocations: PackageAllocation[] = [];
  let left = minutesNeeded;
  for (const pkg of usable) {
    if (left === 0) break;
    const take = Math.min(left, pkg.minutesRemaining);
    allocations.push({ packageId: pkg.id, minutes: take });
    left -= take;
  }
  return { allocations, shortfallMinutes: left };
}

export interface BookingPriceSplit {
  packageMinutes: number;
  regularMinutes: number;
  /** מה שנשאר לתשלום רגיל, באגורות (0 אם החבילות כיסו הכול) */
  regularPriceAgorot: number;
  allocations: PackageAllocation[];
}

/** שילוב יתרת חבילה עם תשלום רגיל להזמנה אחת */
export function splitBookingPrice(
  durationMinutes: number,
  packages: PackageBalance[],
  now: Date,
  hourlyAgorot: number
): BookingPriceSplit {
  assertQuarterHours(durationMinutes);
  const { allocations, shortfallMinutes } = allocatePackageMinutes(packages, durationMinutes, now);
  return {
    packageMinutes: durationMinutes - shortfallMinutes,
    regularMinutes: shortfallMinutes,
    regularPriceAgorot: shortfallMinutes === 0 ? 0 : regularPriceAgorot(shortfallMinutes, hourlyAgorot),
    allocations,
  };
}

// ---- משמרות קבועות ----
// המשבצות והמחירים החודשיים נשמרים במסד וניתנים לעריכה ע"י מנהל: ראו src/lib/shifts/windows.ts

/** תצוגה: 4160 -> "41.60" */
export function formatAgorot(agorot: number): string {
  const sign = agorot < 0 ? "-" : "";
  const abs = Math.abs(agorot);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
