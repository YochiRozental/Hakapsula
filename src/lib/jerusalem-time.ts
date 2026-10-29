// גבולות יום לפי Asia/Jerusalem (כולל מעבר שעון קיץ/חורף), בלי תלות באזור הזמן של השרת או של הדפדפן.

const TZ = "Asia/Jerusalem";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** ההפרש (ms) בין שעון ירושלים ל-UTC ברגע נתון */
function zoneOffsetMs(instant: number): number {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(instant))) {
    if (type !== "literal") p[type] = Number(value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** הרגע (UTC) שבו שעון הקיר בירושלים מראה את התאריך והשעה האלה */
function wallTimeToInstant(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const first = guess - zoneOffsetMs(guess);
  const second = guess - zoneOffsetMs(first);
  return second;
}

function parseIso(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

/** תחילת היום (00:00 בירושלים) של תאריך YYYY-MM-DD */
export function jerusalemDayStart(iso: string): Date {
  const [y, m, d] = parseIso(iso);
  return new Date(wallTimeToInstant(y, m, d));
}

/**
 * הרגע (UTC) ששעון הקיר בירושלים מראה בו את התאריך YYYY-MM-DD ואת מספר הדקות מחצות. נכון גם בימי מעבר שעון קיץ/חורף
 * (שעה שלא קיימת מתקדמת; שעה כפולה בוחרת את המופע הראשון), כך ש-12:15 הוא תמיד 12:15 בירושלים.
 */
export function jerusalemWallInstant(iso: string, minutesOfDay: number): Date {
  const [y, m, d] = parseIso(iso);
  const guess = Date.UTC(y, m - 1, d, 0, minutesOfDay, 0);
  const first = guess - zoneOffsetMs(guess);
  return new Date(guess - zoneOffsetMs(first));
}

/** סוף היום: אלפית שנייה לפני תחילת היום הבא (נכון גם ליום של 23 או 25 שעות) */
export function jerusalemDayEnd(iso: string): Date {
  const [y, m, d] = parseIso(iso);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return new Date(wallTimeToInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1);
}

/** התאריך הנוכחי בירושלים (YYYY-MM-DD) */
export function jerusalemTodayIso(now: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(now)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
