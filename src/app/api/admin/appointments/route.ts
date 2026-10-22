import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { createAppointment, BookingError } from "@/lib/booking";
import type { Prisma, RoomKey } from "@/generated/prisma/client";
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

// שדות שמותר לסנן לפיהם בטבלת התורים
const APPOINTMENT_FILTER_FIELDS: Record<string, ServerField> = {
  startTime: { type: "date", path: ["startTime"] },
  room: { type: "select", path: ["room", "key"] },
  status: { type: "select", path: ["status"] },
  source: { type: "select", path: ["source"] },
  userName: { type: "text", path: ["user", "name"] },
  userEmail: { type: "text", path: ["user", "email"] },
  userPhone: { type: "text", path: ["user", "phone"] },
  notes: { type: "text", path: ["notes"] },
  createdAt: { type: "date", path: ["createdAt"] },
};

// עמודות הניתנות למיון. טקסט: מיון עברית/אנגלית בזיכרון; שאר העמודות: במסד
const APPOINTMENT_SORT_FIELDS: Record<string, SortField> = {
  startTime: { orderBy: (dir) => ({ startTime: dir }) },
  room: { orderBy: (dir) => ({ room: { key: dir } }) },
  userName: { text: ["user", "name"] },
  userPhone: { text: ["user", "phone"] },
  source: { orderBy: (dir) => ({ source: dir }) },
  status: { orderBy: (dir) => ({ status: dir }) },
};

const APPOINTMENT_SEARCH_PATHS = [["user", "name"], ["user", "email"], ["user", "phone"], ["notes"], ["room", "name"]];

export async function GET(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { searchParams } = new URL(request.url);

  if (searchParams.has("page")) {
    const query = parseListQuery(searchParams);
    const filtered = (await buildWhere(query, {
      searchPaths: APPOINTMENT_SEARCH_PATHS,
      fields: APPOINTMENT_FILTER_FIELDS,
    })) as Prisma.AppointmentWhereInput;
    // בסינון לפי תאריך התורים מוצגים בסדר כרונולוגי; בלעדיו — החדשים קודם
    const byDate = query.filters.some((f) => f.key === "startTime");
    const include = { room: true, user: { select: { id: true, name: true, email: true, phone: true } } };
    const skip = (query.page - 1) * query.pageSize;
    const plan = resolveSort(query.sort, APPOINTMENT_SORT_FIELDS, [{ startTime: byDate ? "asc" : "desc" }]);

    if (plan.kind === "text") {
      const all = await prisma.appointment.findMany({ where: filtered, select: textSortSelect(plan.path) as { id: true } });
      const { ids, total } = textSortPage(all, plan, skip, query.pageSize);
      const rows = await prisma.appointment.findMany({ where: { id: { in: ids } }, include });
      return NextResponse.json({ appointments: orderByIds(rows, ids), total });
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where: filtered,
        include,
        orderBy: plan.orderBy as Prisma.AppointmentOrderByWithRelationInput[],
        skip,
        take: query.pageSize,
      }),
      prisma.appointment.count({ where: filtered }),
    ]);
    return NextResponse.json({ appointments, total });
  }

  const date = searchParams.get("date");
  const roomKey = searchParams.get("roomKey") as RoomKey | null;

  const where: {
    startTime?: { lte: Date };
    endTime?: { gte: Date };
    room?: { key: RoomKey };
  } = {};

  if (date) {
    where.startTime = { lte: new Date(`${date}T23:59:59`) };
    where.endTime = { gte: new Date(`${date}T00:00:00`) };
  }
  if (roomKey) {
    where.room = { key: roomKey };
  }

  const appointments = await prisma.appointment.findMany({
    where,
    include: { room: true, user: { select: { id: true, name: true, email: true, phone: true } } },
    orderBy: { startTime: "asc" },
  });

  return NextResponse.json(appointments);
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const userId = body?.userId as string | undefined;
  const roomKey = body?.roomKey as RoomKey | undefined;
  const startTime = body?.startTime as string | undefined;
  const endTime = body?.endTime as string | undefined;
  const notes = body?.notes as string | undefined;

  if (!userId || !roomKey || !startTime || !endTime) {
    return NextResponse.json({ error: "חסרים פרטים לקביעת התור" }, { status: 400 });
  }

  try {
    const appointment = await createAppointment({
      userId,
      roomKey,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      notes,
      source: "ADMIN",
    });
    return NextResponse.json(appointment, { status: 201 });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "שגיאה בקביעת התור" }, { status: 500 });
  }
}
