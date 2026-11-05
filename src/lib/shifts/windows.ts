/**
 * משבצות משמרת (שעות ומחיר חודשי): טיפוסים, תצוגה, תמחור ואימות. פונקציות טהורות, בטוחות לדפדפן ולשרת.
 * הנתונים עצמם נשמרים בטבלת ShiftWindow ונערכים ע"י מנהל (ראו windows-db.ts).
 *
 * תמחור: המחיר החודשי קבוע למשבצת, בשקלים שלמים, והוא מה שמחויב בכל אחד משלושת החיובים (ראו calendar.ts).
 */

export interface ShiftWindowDef {
  id: string;
  name: string;
  startMinutes: number;
  endMinutes: number;
  monthlyPriceAgorot: number;
  active: boolean;
  sortOrder: number;
}

export const SHIFT_WINDOW_STEP_MINUTES = 15;
export const MAX_WINDOW_NAME_LENGTH = 40;
export const MAX_MONTHLY_PRICE_SHEKEL = 100_000;
export const MAX_SHIFT_WINDOWS = 12;

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function windowLabelOf(w: Pick<ShiftWindowDef, "name" | "startMinutes" | "endMinutes">): string {
  return `${w.name} ${hhmm(w.startMinutes)}–${hhmm(w.endMinutes)}`;
}

export interface WindowInput {
  id?: string;
  name: string;
  startMinutes: number;
  endMinutes: number;
  /** בשקלים שלמים */
  monthlyPriceShekel: number;
  active: boolean;
}

/** אימות רשימת משבצות לשמירה. מחזיר הודעת שגיאה או null */
export function validateWindowInputs(list: WindowInput[]): string | null {
  if (list.length === 0 || list.length > MAX_SHIFT_WINDOWS) return `מספר המשבצות חייב להיות בין 1 ל-${MAX_SHIFT_WINDOWS}`;
  for (const w of list) {
    const name = w.name.trim();
    if (!name || name.length > MAX_WINDOW_NAME_LENGTH) return `שם משבצת חייב להיות באורך 1 עד ${MAX_WINDOW_NAME_LENGTH} תווים`;
    for (const v of [w.startMinutes, w.endMinutes]) {
      if (!Number.isInteger(v) || v < 0 || v > 24 * 60 || v % SHIFT_WINDOW_STEP_MINUTES !== 0) return `שעה חייבת להיות בקפיצות של ${SHIFT_WINDOW_STEP_MINUTES} דקות`;
    }
    if (w.startMinutes >= w.endMinutes) return `במשבצת "${name}" שעת הסיום חייבת להיות אחרי שעת ההתחלה`;
    if (!Number.isInteger(w.monthlyPriceShekel) || w.monthlyPriceShekel <= 0 || w.monthlyPriceShekel > MAX_MONTHLY_PRICE_SHEKEL) {
      return `מחיר חודשי של "${name}" חייב להיות מספר שלם של שקלים בין 1 ל-${MAX_MONTHLY_PRICE_SHEKEL}`;
    }
  }
  const active = list.filter((w) => w.active).sort((a, b) => a.startMinutes - b.startMinutes);
  if (active.length === 0) return "חייבת להישאר לפחות משבצת פעילה אחת";
  for (let i = 1; i < active.length; i++) {
    if (active[i].startMinutes < active[i - 1].endMinutes) return `המשבצות "${active[i - 1].name.trim()}" ו-"${active[i].name.trim()}" חופפות בשעות`;
  }
  return null;
}

// ───────────── רישום משבצות בצד הלקוח (תוויות בלבד) ─────────────

let registry: ShiftWindowDef[] = [];

/** נקרא ע"י ShiftWindowsProvider לפני הצגת רכיבים שמציגים שם משבצת לפי מזהה. תצוגה בלבד: אין בכך שום חישוב עסקי */
export function setShiftWindowRegistry(windows: ShiftWindowDef[]) {
  registry = windows;
}

export function windowLabelById(id: string): string {
  const w = registry.find((x) => x.id === id);
  return w ? windowLabelOf(w) : id;
}
