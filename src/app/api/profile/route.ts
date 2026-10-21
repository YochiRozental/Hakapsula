import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  digitsOnly,
  findIdentityConflict,
  normalizeIdNumber,
  normalizePhone,
  optionalField,
  profileFieldSchemas as fields,
} from "@/lib/profile";
import { isValidCardExpiry } from "@/lib/validators";

// השלמת פרטים להזמנה: כל השדות חובה. כרטיס אשראי קיים (4 ספרות אחרונות) נשמר ואין חובה להזין אותו שוב.
const profileSchema = z.object({
  firstName: fields.firstName,
  lastName: fields.lastName,
  phone: fields.phone,
  idNumber: fields.idNumber,
  gender: fields.gender,
  cardNumber: optionalField(fields.cardNumber),
  cardExpiry: z.string().trim().min(1, "יש להזין תוקף כרטיס").pipe(fields.cardExpiry),
  cardCvv: optionalField(fields.cardCvv),
});

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) {
    return NextResponse.json({ error: "יש להתחבר" }, { status: 401 });
  }

  const { firstName, lastName, phone, idNumber, gender, cardNumber, cardExpiry, cardCvv } = parsed.data;

  if (!cardNumber && !user.cardLast4) {
    return NextResponse.json({ error: "יש להזין מספר כרטיס אשראי" }, { status: 400 });
  }
  if (cardNumber && !cardCvv) {
    return NextResponse.json({ error: "יש להזין 3 ספרות בגב הכרטיס" }, { status: 400 });
  }
  if (!isValidCardExpiry(cardExpiry)) {
    return NextResponse.json({ error: "תוקף הכרטיס לא תקין או שפג" }, { status: 400 });
  }

  const normalizedPhone = normalizePhone(phone);
  const normalizedId = normalizeIdNumber(idNumber);

  const conflict = await findIdentityConflict({ phone: normalizedPhone, idNumber: normalizedId }, user.id);
  if (conflict) {
    return NextResponse.json({ error: conflict }, { status: 409 });
  }

  // מספר הכרטיס המלא וה-CVV לא נשמרים (PCI DSS) — רק 4 ספרות אחרונות ותוקף.
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name: `${firstName} ${lastName}`,
        firstName,
        lastName,
        phone: normalizedPhone,
        idNumber: normalizedId,
        gender,
        cardLast4: cardNumber ? digitsOnly(cardNumber).slice(-4) : undefined,
        cardExpiry,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[profile] failed to update user:", error);
    return NextResponse.json({ error: "שגיאה בשמירת הפרטים, נסה שוב" }, { status: 500 });
  }
}
