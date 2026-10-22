import { SLOT_STEP_MINUTES } from "@/lib/business-rules";
import { formatMinutes } from "@/lib/opening-hours";

/** כל שעות ההתחלה האפשריות ביממה (HH:mm), בקפיצות של SLOT_STEP_MINUTES. הסינון לפי שעות הפעילות נעשה מול הלוח המרכזי (opening-hours) */
export function buildTimeOptions(): string[] {
  const options: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += SLOT_STEP_MINUTES) {
    options.push(formatMinutes(minutes));
  }
  return options;
}

export function todayIsoDate(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

export function combineDateAndTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00`);
}

/** משך ההזמנה היחיד שמוצע כרגע באתר (שעה). שאר האפשרויות ב-DURATION_OPTIONS נשמרות לשימוש עתידי, וכן לטלפון ולממשק המנהל */
export const WEB_BOOKING_DURATION_MINUTES = 60;

export const DURATION_OPTIONS = [
  { label: "15 דקות", minutes: 15 },
  { label: "30 דקות", minutes: 30 },
  { label: "45 דקות", minutes: 45 },
  { label: "שעה", minutes: 60 },
  { label: "שעה וחצי", minutes: 90 },
  { label: "שעתיים", minutes: 120 },
  { label: "3 שעות", minutes: 180 },
];
