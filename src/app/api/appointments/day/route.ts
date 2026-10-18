import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CONFLICTING_ROOM_KEYS } from "@/lib/rooms";
import type { RoomKey } from "@/generated/prisma/client";

export async function GET(request: Request) {
  // זמינות החדרים ציבורית (ללא פרטי משתמשים), כדי שמבקרים יוכלו לראות שעות פנויות לפני התחברות
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const roomKey = searchParams.get("roomKey") as RoomKey | null;

  if (!date || !roomKey || !CONFLICTING_ROOM_KEYS[roomKey]) {
    return NextResponse.json({ error: "פרמטרים חסרים" }, { status: 400 });
  }

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);

  const appointments = await prisma.appointment.findMany({
    where: {
      status: "CONFIRMED",
      room: { key: { in: CONFLICTING_ROOM_KEYS[roomKey] } },
      startTime: { lte: dayEnd },
      endTime: { gte: dayStart },
    },
    select: { startTime: true, endTime: true, room: { select: { key: true, name: true } } },
    orderBy: { startTime: "asc" },
  });

  return NextResponse.json(appointments);
}
