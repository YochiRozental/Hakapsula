import { last9Digits } from "@/ivr/phone";
import { isValidIsraeliPhone } from "@/lib/validators";

/** המשתמש כפי שנדרש לזיהוי — לא נחשף כאן שום שדה רגיש (סיסמה וכו') */
export type IdentifiedUser = { id: string; name: string };

export type CallerStatus = "APPROVED" | "PENDING" | "BLOCKED";

/**
 * תוצאת זיהוי המתקשר. מצב אחד בדיוק, ללא חיפוש כפול:
 * - PRIVATE: מספר חסוי/חסר/לא תקין (ימות מעבירה "AnonymousPhone" או ריק) — אין חיפוש ואין הרשמה
 * - ERROR: כשל במסד הנתונים, או תוצאה דו-משמעית — לא מנתבים, משמיעים הודעת תקלה
 * - NOT_FOUND: מספר תקין שאינו רשום
 * - APPROVED / PENDING / BLOCKED: משתמש רשום לפי סטטוס
 */
export type CallerIdentity =
  | { kind: "PRIVATE" }
  | { kind: "ERROR" }
  | { kind: "NOT_FOUND"; phone: string }
  | { kind: "APPROVED"; phone: string; user: IdentifiedUser }
  | { kind: "PENDING"; phone: string; user: IdentifiedUser }
  | { kind: "BLOCKED"; phone: string; user: IdentifiedUser };

/** משתמש מהמסד כפי שמחזירה פונקציית החיפוש. תוצאה עם יותר ממשתמש אחד נחשבת דו-משמעית */
export type PhoneLookup = (last9: string) => Promise<Array<IdentifiedUser & { status: CallerStatus | string }>>;

/**
 * מנרמל את המספר שימות מעבירה (call.phone) לפורמט "0xxxxxxxxx", או null אם המספר חסוי/חסר/לא תקין.
 * מספר חסוי מגיע כטקסט (AnonymousPhone) או ריק — לכן דורשים שהערך כולו ספרות (עם + ורווחים/מקפים אופציונליים).
 */
export function normalizeCallerPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\+?[\d\s-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "").replace(/^972/, "0");
  if (!isValidIsraeliPhone(digits)) return null;
  return digits;
}

/**
 * פונקציית הזיהוי המרכזית — היחידה ב-IVR שמחפשת משתמש לפי טלפון המתקשר.
 * החיפוש (lookup) מוזרק כדי שאפשר יהיה לבדוק כל מצב בלי מסד נתונים.
 */
export async function identifyCaller(rawPhone: string | undefined | null, lookup: PhoneLookup): Promise<CallerIdentity> {
  const phone = normalizeCallerPhone(rawPhone);
  const last9 = phone && last9Digits(phone);
  if (!phone || !last9) return { kind: "PRIVATE" };

  let matches: Awaited<ReturnType<PhoneLookup>>;
  try {
    matches = await lookup(last9);
  } catch {
    // ללא פרטי השגיאה או המספר בלוג — הם עלולים להכיל פרטים אישיים
    console.error("[ivr] caller lookup failed");
    return { kind: "ERROR" };
  }

  if (matches.length === 0) return { kind: "NOT_FOUND", phone };
  if (matches.length > 1) {
    // שני משתמשים עם אותן 9 ספרות (פורמטים שונים) — לא מנחשים מי המתקשר
    console.error("[ivr] ambiguous caller phone match");
    return { kind: "ERROR" };
  }

  const { id, name, status } = matches[0];
  if (status !== "APPROVED" && status !== "PENDING" && status !== "BLOCKED") return { kind: "ERROR" };
  return { kind: status, phone, user: { id, name } } as CallerIdentity;
}
