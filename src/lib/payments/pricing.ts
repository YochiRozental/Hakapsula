/**
 * תמחור, חבילות ומשמרות. פונקציות טהורות בלבד (ללא מסד נתונים), הכול באגורות שלמות.
 * משכי זמן בדקות, בקפיצות של רבע שעה כמו שאר המערכת (SLOT_STEP_MINUTES).
 */

export const SLOT_MINUTES = 15;

export const REGULAR_HOURLY_AGOROT = 5200; // 52 ₪ לשעה
export const REGULAR_QUARTER_HOUR_AGOROT = 1300; // 13 ₪ לכל 15 דקות

export function assertQuarterHours(minutes: number) {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % SLOT_MINUTES !== 0) {
    throw new RangeError(`משך חייב להיות מכפלה חיובית של ${SLOT_MINUTES} דקות`);
  }
}

/** מחיר רגיל להזמנה לפי משך בדקות */
export function regularPriceAgorot(minutes: number): number {
  assertQuarterHours(minutes);
  return (minutes / SLOT_MINUTES) * REGULAR_QUARTER_HOUR_AGOROT;
}

// ---- חבילות שעות ----

export const HOURS_PACKAGES = [
  { hours: 5, priceAgorot: 19500 },
  { hours: 10, priceAgorot: 36400 },
  { hours: 20, priceAgorot: 67600 },
  { hours: 50, priceAgorot: 143000 },
  { hours: 100, priceAgorot: 275600 },
] as const;

export type HoursPackageOption = (typeof HOURS_PACKAGES)[number];

export function findHoursPackage(hours: number): HoursPackageOption | undefined {
  return HOURS_PACKAGES.find((p) => p.hours === hours);
}

export function packageMinutes(hours: number): number {
  return hours * 60;
}

/** כמה נחסך בחבילה לעומת מחיר רגיל לאותן שעות */
export function packageSavingsAgorot(option: HoursPackageOption): number {
  return regularPriceAgorot(packageMinutes(option.hours)) - option.priceAgorot;
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
  now: Date
): BookingPriceSplit {
  assertQuarterHours(durationMinutes);
  const { allocations, shortfallMinutes } = allocatePackageMinutes(packages, durationMinutes, now);
  return {
    packageMinutes: durationMinutes - shortfallMinutes,
    regularMinutes: shortfallMinutes,
    regularPriceAgorot: shortfallMinutes === 0 ? 0 : regularPriceAgorot(shortfallMinutes),
    allocations,
  };
}

// ---- משמרות קבועות ----

export const SHIFT_DISCOUNT_PERCENT = 20;
/** 41.60 ₪ לשעה */
export const SHIFT_HOURLY_AGOROT = (REGULAR_HOURLY_AGOROT * (100 - SHIFT_DISCOUNT_PERCENT)) / 100;
export const SHIFT_MONTHS = 3;

export const SHIFT_WINDOWS = [
  { id: "MORNING", startMinutes: 8 * 60, endMinutes: 12 * 60 },
  { id: "NOON", startMinutes: 12 * 60 + 15, endMinutes: 16 * 60 },
  { id: "AFTERNOON", startMinutes: 16 * 60 + 15, endMinutes: 20 * 60 },
  { id: "EVENING", startMinutes: 20 * 60 + 15, endMinutes: 23 * 60 },
] as const;

export type ShiftWindowId = (typeof SHIFT_WINDOWS)[number]["id"];

export function findShiftWindow(id: string) {
  return SHIFT_WINDOWS.find((w) => w.id === id);
}

export function shiftWindowMinutes(id: ShiftWindowId): number {
  const w = findShiftWindow(id)!;
  return w.endMinutes - w.startMinutes;
}

/** מחיר מפגש יחיד במשמרת (אגורות): מחיר שעתי מוזל, מחושב לפי דקות */
export function shiftSessionPriceAgorot(windowMinutes: number): number {
  assertQuarterHours(windowMinutes);
  return (windowMinutes / SLOT_MINUTES) * (SHIFT_HOURLY_AGOROT / 4);
}

/** חיוב חודשי לפי מספר המפגשים בפועל באותו חודש */
export function monthlyShiftChargeAgorot(windowId: ShiftWindowId, sessionCount: number): number {
  if (!Number.isInteger(sessionCount) || sessionCount < 0) {
    throw new RangeError("מספר המפגשים חייב להיות שלם ולא שלילי");
  }
  return sessionCount * shiftSessionPriceAgorot(shiftWindowMinutes(windowId));
}

/** תצוגה: 4160 -> "41.60" */
export function formatAgorot(agorot: number): string {
  const sign = agorot < 0 ? "-" : "";
  const abs = Math.abs(agorot);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
