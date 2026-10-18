import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import {
  digitsOnly,
  findIdentityConflict,
  normalizeIdNumber,
  normalizePhone,
  optionalField,
  profileFieldSchemas as fields,
} from "@/lib/profile";

// בהרשמה רק אימייל וסיסמה הכרחיים; שאר הפרטים אופציונליים (אך אם הוזנו — חייבים להיות תקינים).
// פרטי חובה להזמנת חדר נאכפים בעת ההזמנה (ראו src/lib/profile.ts).
const registerSchema = z
  .object({
    email: z.string().trim().email("כתובת אימייל לא תקינה"),
    password: z.string().min(4, "הסיסמה חייבת להכיל לפחות 4 תווים"),
    firstName: optionalField(fields.firstName),
    lastName: optionalField(fields.lastName),
    phone: optionalField(fields.phone),
    idNumber: optionalField(fields.idNumber),
    cardNumber: optionalField(fields.cardNumber),
    cardExpiry: optionalField(fields.cardExpiry),
    cardCvv: optionalField(fields.cardCvv),
  })
  .superRefine((data, ctx) => {
    // פרטי אשראי הם חבילה אחת: אם הוזן חלק מהם, יש להזין את כולם
    const provided = [data.cardNumber, data.cardExpiry, data.cardCvv].filter(Boolean).length;
    if (provided > 0 && provided < 3) {
      ctx.addIssue({ code: "custom", message: "יש להזין את כל פרטי כרטיס האשראי (מספר, תוקף ו-CVV) או להשאיר ריק" });
    }
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
  const normalizedPhone = phone ? normalizePhone(phone) : undefined;
  const normalizedId = idNumber ? normalizeIdNumber(idNumber) : undefined;

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
        name: [firstName, lastName].filter(Boolean).join(" ") || normalizedEmail.split("@")[0],
        firstName,
        lastName,
        email: normalizedEmail,
        phone: normalizedPhone,
        idNumber: normalizedId,
        cardLast4: cardNumber ? digitsOnly(cardNumber).slice(-4) : undefined,
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
