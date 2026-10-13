/** בדיקת ספרת ביקורת של מספר זהות ישראלי (עד 9 ספרות, משלימים באפסים מובילים) */
export function isValidIsraeliId(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 5 || digits.length > 9) return false;
  const padded = digits.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(padded[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** בדיקת Luhn למספר כרטיס אשראי */
export function isValidCardNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** תוקף בפורמט MM/YY שעדיין לא עבר (הכרטיס בתוקף עד סוף החודש) */
export function isValidCardExpiry(value: string, now = new Date()): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

/** מספר טלפון ישראלי (נייד או קווי), עם או בלי קידומת 972 */
export function isValidIsraeliPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").replace(/^972/, "0");
  return /^0\d{8,9}$/.test(digits);
}
