import { prisma } from "@/lib/prisma";
import { ROOM_LABELS } from "@/lib/rooms";
import { ensureRooms } from "@/lib/rooms-db";
import Link from "next/link";
import { EmptyState, Icon, PageHeader, RoomTile, SectionTitle, StatCard } from "@/components/ui";

export default async function AdminDashboardPage() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  await ensureRooms();
  const [todayAppointments, totalUsers, totalUpcoming, rooms] = await Promise.all([
    prisma.appointment.findMany({
      where: { status: "CONFIRMED", startTime: { gte: todayStart, lte: todayEnd } },
      include: { room: true, user: { select: { name: true, phone: true } } },
      orderBy: { startTime: "asc" },
    }),
    prisma.user.count(),
    prisma.appointment.count({ where: { status: "CONFIRMED", startTime: { gte: now } } }),
    prisma.room.findMany(),
  ]);

  const activeRooms = rooms.filter((r) => r.active).length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="סקירה כללית"
        title="לוח בקרה"
        subtitle={now.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        actions={
          <Link href="/admin/appointments" className="btn btn-primary">
            <Icon name="list" className="w-4 h-4" />
            ניהול תורים
          </Link>
        }
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="תורים היום" value={todayAppointments.length} icon="calendar" tone="blue" />
        <StatCard label="תורים עתידיים" value={totalUpcoming} icon="clock" tone="gold" />
        <StatCard label="משתמשים רשומים" value={totalUsers} icon="users" tone="brand" />
        <StatCard label="חדרים פעילים" value={`${activeRooms}/${rooms.length}`} icon="door" tone="stone" />
      </div>

      <div className="grid xl:grid-cols-[1.6fr_1fr] gap-6 items-start">
        <section>
          <SectionTitle
            aside={
              <Link href="/admin/appointments" className="text-sm font-semibold text-brand-700 hover:underline">
                לכל התורים
              </Link>
            }
          >
            התורים של היום
          </SectionTitle>
          {todayAppointments.length === 0 ? (
            <EmptyState>אין תורים קבועים להיום</EmptyState>
          ) : (
            <ul className="card divide-y divide-cream-100 overflow-hidden">
              {todayAppointments.map((a) => (
                <li key={a.id} className="px-4 sm:px-5 py-4 flex flex-wrap items-center gap-3 transition-colors hover:bg-brand-50/40">
                  <RoomTile roomKey={a.room.key} className="w-11 h-11 [&>svg]:w-5 [&>svg]:h-5" />
                  <div className="flex-1 min-w-32">
                    <p className="font-bold text-stone-800">{a.user.name}</p>
                    <p className="text-xs text-stone-500">
                      {ROOM_LABELS[a.room.key]}
                      {a.user.phone ? ` · ${a.user.phone}` : ""}
                    </p>
                  </div>
                  <span className="badge bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200 tabular-nums">
                    {a.startTime.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                    {" – "}
                    {a.endTime.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle>מצב חדרים</SectionTitle>
          <ul className="card divide-y divide-cream-100 overflow-hidden">
            {rooms.map((room) => (
              <li key={room.id} className="px-4 sm:px-5 py-3.5 flex items-center gap-3">
                <RoomTile roomKey={room.key} className="w-10 h-10 [&>svg]:w-5 [&>svg]:h-5" />
                <span className="flex-1 font-semibold text-stone-700">{room.name}</span>
                <span
                  className={`badge ${room.active ? "bg-brand-50 text-brand-700" : "bg-red-50 text-red-600"}`}
                >
                  {room.active ? "פעיל" : "מושבת"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
