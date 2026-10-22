import { randomInt } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  buildWhere,
  orderByIds,
  parseListQuery,
  resolveSort,
  textSortPage,
  textSortSelect,
  type ServerField,
  type SortField,
} from "@/lib/table-filters-server";
import type { Filter } from "@/lib/table-filters";
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

// שדות שמותר לסנן לפיהם. תעודת זהות וכרטיס אשראי אינם ברשימה, ולכן אי אפשר לסנן או לחפש לפיהם
const USER_FILTER_FIELDS: Record<string, ServerField> = {
  name: { type: "text", path: ["name"] },
  email: { type: "text", path: ["email"] },
  phone: { type: "text", path: ["phone"] },
  createdAt: { type: "date", path: ["createdAt"] },
  role: { type: "select", path: ["role"] },
  status: { type: "select", path: ["status"] },
  appointments: { type: "number", build: appointmentCountCondition },
};

// עמודות הניתנות למיון. טקסט: מיון עברית/אנגלית בזיכרון; שאר העמודות: במסד
const USER_SORT_FIELDS: Record<string, SortField> = {
  name: { text: ["name"] },
  email: { text: ["email"] },
  phone: { text: ["phone"] },
  createdAt: { orderBy: (dir) => ({ createdAt: dir }) },
  appointments: { orderBy: (dir) => ({ appointments: { _count: dir } }) },
  role: { orderBy: (dir) => ({ role: dir }) },
  status: { orderBy: (dir) => ({ status: dir }) },
};

const USER_SEARCH_PATHS = [["name"], ["email"], ["phone"]];

// ספירת תורים אינה ניתנת לסינון ישיר ב-where, ולכן מחשבים את מזהי המשתמשים המתאימים לפי groupBy
async function appointmentCountCondition(f: Filter) {
  const a = f.value?.trim() ? Number(f.value) : NaN;
  const b = f.value2?.trim() ? Number(f.value2) : NaN;
  let matches: (count: number) => boolean;
  if (f.op === "eq" && !Number.isNaN(a)) matches = (c) => c === a;
  else if (f.op === "gt" && !Number.isNaN(a)) matches = (c) => c > a;
  else if (f.op === "lt" && !Number.isNaN(a)) matches = (c) => c < a;
  else if (f.op === "between" && !(Number.isNaN(a) && Number.isNaN(b))) {
    matches = (c) => (Number.isNaN(a) || c >= a) && (Number.isNaN(b) || c <= b);
  } else return {};

  const grouped = await prisma.appointment.groupBy({ by: ["userId"], _count: { _all: true } });
  // משתמש ללא תורים לא מופיע ב-groupBy (ספירה 0)
  if (matches(0)) {
    return { id: { notIn: grouped.filter((g) => !matches(g._count._all)).map((g) => g.userId) } };
  }
  return { id: { in: grouped.filter((g) => matches(g._count._all)).map((g) => g.userId) } };
}

export async function GET(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const query = parseListQuery(searchParams);
  const where = (await buildWhere(query, {
    searchPaths: USER_SEARCH_PATHS,
    fields: USER_FILTER_FIELDS,
  })) as Prisma.UserWhereInput;

  const select = {
    id: true,
    name: true,
    email: true,
    phone: true,
    role: true,
    status: true,
    createdAt: true,
    _count: { select: { appointments: true } },
  } satisfies Prisma.UserSelect;

  if (!searchParams.has("page")) {
    // תאימות לאחור (חיפוש לקוח בטופס קביעת תור ידנית): מערך פשוט עם תקרה
    const users = await prisma.user.findMany({
      where,
      select,
      orderBy: { createdAt: "desc" },
      take: query.search ? 20 : 100,
    });
    return NextResponse.json(users);
  }

  const skip = (query.page - 1) * query.pageSize;
  const plan = resolveSort(query.sort, USER_SORT_FIELDS, [{ createdAt: "desc" }]);

  if (plan.kind === "text") {
    const all = await prisma.user.findMany({ where, select: textSortSelect(plan.path) as { id: true } });
    const { ids, total } = textSortPage(all, plan, skip, query.pageSize);
    const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select });
    return NextResponse.json({ users: orderByIds(rows, ids), total });
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select,
      orderBy: plan.orderBy as Prisma.UserOrderByWithRelationInput[],
      skip,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  return NextResponse.json({ users, total });
}
