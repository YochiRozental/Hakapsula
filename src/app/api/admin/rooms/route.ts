import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { ROOM_KEYS } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  await ensureRooms();
  const rooms = await prisma.room.findMany();
  rooms.sort((a, b) => ROOM_KEYS.indexOf(a.key) - ROOM_KEYS.indexOf(b.key));
  return NextResponse.json(rooms);
}
