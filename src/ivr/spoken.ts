/** ניסוח מילולי להקראה בטלפון (TTS). בלי נקודה, מקף, גרש או גרשיים: ימות המשיח אינה מקבלת אותם בהקראה */

/** 2600 -> "26 שקלים"; 5200 -> "52 שקלים"; 4160 -> "41 שקלים ו60 אגורות"; 100 -> "שקל אחד" */
export function spokenShekel(agorot: number): string {
  const whole = Math.floor(agorot / 100);
  const frac = agorot % 100;
  const shekels = whole === 1 ? "שקל אחד" : `${whole} שקלים`;
  return frac ? `${shekels} ו${frac} אגורות` : shekels;
}

/** 60 -> "שעה"; 30 -> "30 דקות"; 90 -> "שעה ו30 דקות"; 120 -> "שעתיים"; 180 -> "3 שעות" */
export function spokenMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`;
  const mins = m === 0 ? "" : `${m} דקות`;
  if (hours && mins) return `${hours} ו${mins}`;
  return hours || mins || "אפס דקות";
}

/** התאריך והשעה בניסוח זהה להודעת האישור הקיימת של ה-IVR */
export function spokenWhen(start: Date): string {
  return `בתאריך ${start.getDate()} ל${start.getMonth() + 1}, בשעה ${start.getHours()} ${start.getMinutes()}`;
}
