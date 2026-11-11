import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import {
  digitsOnly,
  findIdentityConflict,
  normalizeIdNumber,
  normalizePhone,
  profileFieldSchemas as fields,
} from "@/lib/profile";

// כל שדות ההרשמה הם שדות חובה.
const registerSchema = z.object({
  firstName: fields.firstName,
  lastName: fields.lastName,
  email: z.string().trim().email("כתובת אימייל לא תקינה"),
  phone: fields.phone,
  idNumber: fields.idNumber,
  cardNumber: fields.cardNumber,
  cardExpiry: z.string().trim().min(1, "יש להזין תוקף כרטיס").pipe(fields.cardExpiry),
  cardCvv: fields.cardCvv,
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
  const normalizedPhone = normalizePhone(phone);
  const normalizedId = normalizeIdNumber(idNumber);

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return NextResponse.json({ error: "כתובת האימייל כבר רשומה במערכת" }, { status: 409 });
  }

  const conflict = await findIdentityConflict({ phone: normalizedPhone, idNumber: normalizedId });
  if (conflict) {
    return NextResponse.json({ error: conflict }, { status: 409 });
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
