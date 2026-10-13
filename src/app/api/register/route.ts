import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { last9Digits } from "@/ivr/phone";
import { isValidCardExpiry, isValidCardNumber, isValidIsraeliId, isValidIsraeliPhone } from "@/lib/validators";

const digitsOnly = (value: string) => value.replace(/\D/g, "");

const registerSchema = z.object({
  firstName: z.string().trim().min(2, "יש להזין שם פרטי"),
  lastName: z.string().trim().min(2, "יש להזין שם משפחה"),
  email: z.string().trim().email("כתובת אימייל לא תקינה"),
  phone: z.string().trim().refine(isValidIsraeliPhone, "מספר פלאפון לא תקין"),
  idNumber: z.string().trim().refine(isValidIsraeliId, "מספר זהות לא תקין"),
  cardNumber: z.string().trim().refine(isValidCardNumber, "מספר כרטיס אשראי לא תקין"),
  cardExpiry: z.string().trim().refine((v) => isValidCardExpiry(v), "תוקף הכרטיס לא תקין או שפג"),
  cardCvv: z.string().trim().regex(/^\d{3}$/, "יש להזין 3 ספרות בגב הכרטיס"),
  password: z.string().min(4, "הסיסמה חייבת להכיל לפחות 4 תווים"),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" },
      { status: 400 }
    );
  }

  // מספר הכרטיס המלא וה-CVV לא נשמרים — שמירתם אסורה לפי תקן PCI DSS.
  // נשמרות רק 4 הספרות האחרונות והתוקף, לצורך זיהוי הכרטיס.
  const { firstName, lastName, email, phone, idNumber, cardNumber, cardExpiry, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const normalizedPhone = digitsOnly(phone).replace(/^972/, "0");
  const normalizedId = digitsOnly(idNumber).padStart(9, "0");

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return NextResponse.json({ error: "כתובת האימייל כבר רשומה במערכת" }, { status: 409 });
  }

  const phoneTaken = await prisma.user.findFirst({
    where: { phone: { endsWith: last9Digits(normalizedPhone) ?? normalizedPhone } },
  });
  if (phoneTaken) {
    return NextResponse.json({ error: "מספר הפלאפון כבר רשום במערכת" }, { status: 409 });
  }

  const idTaken = await prisma.user.findUnique({ where: { idNumber: normalizedId } });
  if (idTaken) {
    return NextResponse.json({ error: "מספר הזהות כבר רשום במערכת" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.user.create({
      data: {
        name: `${firstName} ${lastName}`,
        firstName,
        lastName,
        email: normalizedEmail,
        phone: normalizedPhone,
        idNumber: normalizedId,
        cardLast4: digitsOnly(cardNumber).slice(-4),
        cardExpiry,
        passwordHash,
      },
    });

    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (error) {
    console.error("[register] failed to create user:", error);
    return NextResponse.json({ error: "שגיאה בשמירת הפרטים, נסה שוב" }, { status: 500 });
  }
}
