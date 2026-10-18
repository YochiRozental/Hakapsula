import { randomInt } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import {
  findIdentityConflict,
  normalizeIdNumber,
  normalizePhone,
  optionalField,
  profileFieldSchemas as fields,
} from "@/lib/profile";

// מנהל מוסיף משתמש ידנית: שם פרטי ושם משפחה חובה; אימייל, פלאפון, ת"ז וסיסמה אופציונליים.
// בלי סיסמה — נוצרת סיסמה זמנית אקראית, שמוחזרת למנהל פעם אחת.
const createUserSchema = z.object({
  firstName: fields.firstName,
  lastName: fields.lastName,
  email: optionalField(z.string().trim().email("כתובת אימייל לא תקינה")),
  phone: optionalField(fields.phone),
  idNumber: optionalField(fields.idNumber),
  password: optionalField(z.string().min(4, "הסיסמה חייבת להכיל לפחות 4 תווים")),
  role: z.enum(["CLIENT", "ADMIN"]).default("CLIENT"),
  status: z.enum(["PENDING", "APPROVED", "BLOCKED"]).default("APPROVED"),
});

// בלי תווים מבלבלים (0/O, 1/l/I) כדי שקל יהיה להקריא ולהקליד
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateTemporaryPassword = (length = 10) =>
  Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });
  }

  const { firstName, lastName, email, phone, idNumber, password, role, status } = parsed.data;
  const normalizedEmail = email?.toLowerCase();
  const normalizedPhone = phone ? normalizePhone(phone) : undefined;
  const normalizedId = idNumber ? normalizeIdNumber(idNumber) : undefined;

  if (!normalizedEmail && !normalizedPhone) {
    return NextResponse.json({ error: "יש להזין אימייל או פלאפון" }, { status: 400 });
  }

  if (normalizedEmail) {
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return NextResponse.json({ error: "כתובת האימייל כבר רשומה במערכת" }, { status: 409 });
  }

  const conflict = await findIdentityConflict({ phone: normalizedPhone, idNumber: normalizedId });
  if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });

  // סיסמה שהוגדרה ע"י מנהל היא תמיד זמנית: המשתמש יידרש להחליף אותה בכניסה הראשונה
  const temporaryPassword = password ?? generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const user = await prisma.user.create({
      data: {
        name: `${firstName} ${lastName}`,
        firstName,
        lastName,
        email: normalizedEmail,
        phone: normalizedPhone,
        idNumber: normalizedId,
        passwordHash,
        mustChangePassword: true,
        role,
        status,
      },
      select: { id: true, name: true, email: true },
    });
    return NextResponse.json({ ...user, temporaryPassword }, { status: 201 });
  } catch (error) {
    console.error("[admin/users] failed to create user:", error);
    return NextResponse.json({ error: "שגיאה בשמירת המשתמש, נסה שוב" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search")?.trim();

  const users = await prisma.user.findMany({
    where: search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      _count: { select: { appointments: true } },
    },
    orderBy: { createdAt: "desc" },
    take: search ? 20 : 100,
  });

  return NextResponse.json(users);
}
