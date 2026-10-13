"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ROOM_LABELS } from "@/lib/rooms";
import { Alert, EmptyState, Icon, Loading, PageHeader, RoomTile, RoomVisual, SectionTitle } from "@/components/ui";
import type { RoomKey } from "@/generated/prisma/client";

type Appointment = {
  id: string;
  startTime: string;
  endTime: string;
  status: "CONFIRMED" | "CANCELLED";
  notes: string | null;
  room: { key: RoomKey; name: string };
};

export default function MyAppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  function load() {
    setNow(Date.now());
    fetch("/api/appointments")
      .then((res) => res.json())
      .then((data) => setAppointments(Array.isArray(data) ? data : []));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot "now" once on mount to classify upcoming/past appointments
    load();
  }, []);

  async function handleCancel(id: string) {
    setCancellingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/appointments/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "שגיאה בביטול התור");
        return;
      }
      load();
    } finally {
      setCancellingId(null);
    }
  }

  const upcoming = appointments?.filter(
    (a) => a.status === "CONFIRMED" && new Date(a.endTime).getTime() >= (now ?? 0)
  );
  const past = appointments?.filter(
    (a) => a.status === "CANCELLED" || new Date(a.endTime).getTime() < (now ?? 0)
  );

  const timeRange = (a: Appointment) =>
    `${new Date(a.startTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })} – ${new Date(
      a.endTime
    ).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        eyebrow="האזור האישי"
        title="התורים שלי"
        subtitle="רשימת התורים הקרובים והעבר שלך"
        actions={
          <Link href="/booking" className="btn btn-primary">
            <Icon name="plus" className="w-4 h-4" />
            קביעת תור
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {appointments === null ? (
        <Loading />
      ) : (
        <>
          <section className="mb-10">
            <SectionTitle>תורים קרובים</SectionTitle>
            {upcoming && upcoming.length > 0 ? (
              <ul className="space-y-3">
                {upcoming.map((a) => (
                  <li key={a.id} className="card card-hover p-3 sm:p-4 flex flex-wrap items-center gap-4">
                    <RoomVisual roomKey={a.room.key} className="w-24 h-20 sm:w-28 sm:h-20 rounded-2xl shrink-0 ring-1 ring-cream-200" />
                    <div className="flex-1 min-w-40">
                      <p className="font-display text-lg font-bold text-stone-900">{ROOM_LABELS[a.room.key]}</p>
                      <p className="text-sm text-stone-500 tabular-nums mt-0.5">
                        {new Date(a.startTime).toLocaleDateString("he-IL")}
                        {" · "}
                        {timeRange(a)}
                      </p>
                      {a.notes && <p className="text-sm text-stone-400 mt-1">{a.notes}</p>}
                    </div>
                    <span className="badge bg-brand-50 text-brand-700 ring-1 ring-brand-100">קרוב</span>
                    <button
                      onClick={() => handleCancel(a.id)}
                      disabled={cancellingId === a.id}
                      className="btn btn-danger btn-sm"
                    >
                      {cancellingId === a.id ? "מבטל..." : "ביטול"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>אין תורים קרובים</EmptyState>
            )}
          </section>

          {past && past.length > 0 && (
            <section>
              <SectionTitle>היסטוריה</SectionTitle>
              <ul className="card divide-y divide-cream-100 overflow-hidden">
                {past.map((a) => (
                  <li key={a.id} className="px-4 sm:px-5 py-3 text-sm flex items-center gap-3">
                    <RoomTile roomKey={a.room.key} className="w-9 h-9 opacity-70 [&>svg]:w-4 [&>svg]:h-4" />
                    <span className="flex-1 text-stone-600 tabular-nums">
                      <span className="font-semibold text-stone-700">{ROOM_LABELS[a.room.key]}</span> ·{" "}
                      {new Date(a.startTime).toLocaleDateString("he-IL")}{" "}
                      {new Date(a.startTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span
                      className={`badge ${
                        a.status === "CANCELLED" ? "bg-red-50 text-red-600" : "bg-cream-100 text-stone-500"
                      }`}
                    >
                      {a.status === "CANCELLED" ? "בוטל" : "הסתיים"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
