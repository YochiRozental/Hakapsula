import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { last9Digits } from "@/ivr/phone";
import { isValidCardExpiry, isValidCardNumber, isValidIsraeliId, isValidIsraeliPhone } from "@/lib/validators";

export const digitsOnly = (value: string) => value.replace(/\D/g, "");
export const normalizePhone = (value: string) => digitsOnly(value).replace(/^972/, "0");
export const normalizeIdNumber = (value: string) => digitsOnly(value).padStart(9, "0");

/** כללי התקינות של שדות הפרופיל — משותפים להרשמה (אופציונלי) ולהשלמת פרטים (חובה) */
export const profileFieldSchemas = {
  firstName: z.string().trim().min(2, "יש להזין שם פרטי"),
  lastName: z.string().trim().min(2, "יש להזין שם משפחה"),
  phone: z.string().trim().refine(isValidIsraeliPhone, "מספר פלאפון לא תקין"),
  idNumber: z.string().trim().refine(isValidIsraeliId, "מספר זהות לא תקין"),
  cardNumber: z.string().trim().refine(isValidCardNumber, "מספר כרטיס אשראי לא תקין"),
  cardExpiry: z.string().trim().refine((v) => isValidCardExpiry(v), "תוקף הכרטיס לא תקין או שפג"),
  cardCvv: z.string().trim().regex(/^\d{3}$/, "יש להזין 3 ספרות בגב הכרטיס"),
};

/** שדה שמותר להשאיר ריק: מחרוזת ריקה נחשבת כלא הוזן */
export const optionalField = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

export type BookingDetails = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  idNumber: string | null;
  cardLast4: string | null;
  cardExpiry: string | null;
};

export type MissingField = "firstName" | "lastName" | "phone" | "idNumber" | "cardNumber" | "cardExpiry";

/** השדות שחסרים או אינם תקינים כדי שאפשר יהיה להזמין חדר (ריק = ההזמנה מותרת) */
export function getMissingBookingDetails(user: BookingDetails): MissingField[] {
  const missing: MissingField[] = [];
  if (!user.firstName?.trim()) missing.push("firstName");
  if (!user.lastName?.trim()) missing.push("lastName");
  if (!user.phone || !isValidIsraeliPhone(user.phone)) missing.push("phone");
  if (!user.idNumber || !isValidIsraeliId(user.idNumber)) missing.push("idNumber");
  if (!user.cardLast4) missing.push("cardNumber");
  if (!user.cardExpiry || !isValidCardExpiry(user.cardExpiry)) missing.push("cardExpiry");
  return missing;
}

/** בודק שפלאפון / ת"ז אינם שייכים למשתמש אחר. מחזיר הודעת שגיאה או null */
export async function findIdentityConflict(
  { phone, idNumber }: { phone?: string; idNumber?: string },
  excludeUserId?: string
): Promise<string | null> {
  const notSelf = excludeUserId ? { id: { not: excludeUserId } } : {};

  if (phone) {
    const phoneTaken = await prisma.user.findFirst({
      where: { ...notSelf, phone: { endsWith: last9Digits(phone) ?? phone } },
    });
    if (phoneTaken) return "מספר הפלאפון כבר רשום במערכת";
  }

  if (idNumber) {
    const idTaken = await prisma.user.findFirst({ where: { ...notSelf, idNumber } });
    if (idTaken) return "מספר הזהות כבר רשום במערכת";
  }

  return null;
}
