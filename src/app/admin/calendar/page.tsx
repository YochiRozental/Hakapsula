"use client";

import { useEffect, useState } from "react";
import { MonthCalendar } from "@/components/month-calendar";
import { PageHeader, ROOM_ACCENTS } from "@/components/ui";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { BUSINESS_HOURS } from "@/lib/business-rules";
import { todayIsoDate } from "@/lib/slots";
import type { RoomKey } from "@/generated/prisma/client";

type Appointment = {
  id: string;
  startTime: string;
  endTime: string;
  status: "CONFIRMED" | "CANCELLED";
  notes: string | null;
  room: { key: RoomKey; name: string };
  user: { id: string; name: string; email: string; phone: string | null };
};

const PX_PER_MINUTE = 0.9;
const DAY_START_MIN = BUSINESS_HOURS.startHour * 60;
const DAY_END_MIN = BUSINESS_HOURS.endHour * 60;
const DAY_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MINUTE;

const HOUR_MARKS = Array.from(
  { length: BUSINESS_HOURS.endHour - BUSINESS_HOURS.startHour + 1 },
  (_, i) => BUSINESS_HOURS.startHour + i
);

function parseIsoDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

export default function AdminCalendarPage() {
  const [date, setDate] = useState(todayIsoDate());
  const [markedDates, setMarkedDates] = useState<Set<string>>(new Set());
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  function loadMonth(year: number, month: number) {
    fetch(`/api/admin/appointments/month?year=${year}&month=${month + 1}`)
      .then((res) => res.json())
      .then((data) => setMarkedDates(new Set(Array.isArray(data) ? data : [])));
  }

  function loadDay() {
    fetch(`/api/admin/appointments?date=${date}`)
      .then((res) => res.json())
      .then((data) => setAppointments(Array.isArray(data) ? data : []));
  }

  useEffect(() => {
    const { year, month } = parseIsoDate(date);
    loadMonth(year, month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(loadDay, [date]);

  async function handleCancel(id: string) {
    if (!confirm("לבטל את התור?")) return;
    setCancellingId(id);
    await fetch(`/api/appointments/${id}`, { method: "DELETE" });
    setCancellingId(null);
    loadDay();
  }

  const confirmed = appointments?.filter((a) => a.status === "CONFIRMED") ?? [];

  return (
    <div>
      <PageHeader eyebrow="תצוגה יומית" title="יומן החדרים" subtitle="לחיצה על תור ביומן מאפשרת לבטל אותו" />
      <div className="grid xl:grid-cols-[1fr_290px] gap-6 items-start">
        <div className="card overflow-hidden order-2 xl:order-1">
          <div className="px-5 py-4 border-b border-cream-200 flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-lg font-bold text-stone-900">
              {new Date(`${date}T00:00:00`).toLocaleDateString("he-IL", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
            <span className="badge bg-brand-50 text-brand-700">{confirmed.length} תורים</span>
          </div>

          <div className="overflow-x-auto">
            <div className="flex min-w-[640px]">
              <div className="w-16 shrink-0 border-l border-cream-100 bg-bronze-50/50">
                <div className="h-12 border-b border-cream-200" />
                <div className="relative" style={{ height: DAY_HEIGHT }}>
                  {HOUR_MARKS.map((h) => (
                    <div
                      key={h}
                      className="absolute right-2 text-xs text-stone-400 tabular-nums -translate-y-1/2"
                      style={{ top: (h * 60 - DAY_START_MIN) * PX_PER_MINUTE }}
                    >
                      {String(h).padStart(2, "0")}:00
                    </div>
                  ))}
                </div>
              </div>

              {ROOM_KEYS.map((roomKey) => (
                <div key={roomKey} className="flex-1 min-w-[140px] border-l border-cream-100 last:border-l-0">
                  <div className="h-12 border-b border-cream-200 flex items-center justify-center gap-2 text-sm font-bold text-stone-700">
                    <span className={`w-2 h-2 rounded-full ${ROOM_ACCENTS[roomKey].dot}`} />
                    {ROOM_LABELS[roomKey]}
                  </div>
                  <div className="relative" style={{ height: DAY_HEIGHT }}>
                    {HOUR_MARKS.map((h) => (
                      <div
                        key={h}
                        className="absolute w-full border-t border-cream-100"
                        style={{ top: (h * 60 - DAY_START_MIN) * PX_PER_MINUTE }}
                      />
                    ))}

                    {confirmed
                      .filter((a) => a.room.key === roomKey)
                      .map((a) => {
                        const start = new Date(a.startTime);
                        const end = new Date(a.endTime);
                        const startMin = start.getHours() * 60 + start.getMinutes();
                        const endMin = end.getHours() * 60 + end.getMinutes();
                        const top = (startMin - DAY_START_MIN) * PX_PER_MINUTE;
                        const height = Math.max((endMin - startMin) * PX_PER_MINUTE, 20);

                        return (
                          <button
                            key={a.id}
                            onClick={() => handleCancel(a.id)}
                            disabled={cancellingId === a.id}
                            title="לחץ לביטול התור"
                            className={`absolute right-1.5 left-1.5 rounded-lg border text-right px-2 py-1 overflow-hidden shadow-sm transition-colors hover:bg-red-50 hover:border-red-300 hover:text-red-800 disabled:opacity-50 cursor-pointer ${ROOM_ACCENTS[roomKey].block}`}
                            style={{ top, height }}
                          >
                            <p className="text-xs font-bold truncate">{a.user.name}</p>
                            <p className="text-[11px] opacity-75 tabular-nums truncate">
                              {start.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                              {"–"}
                              {end.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                            </p>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4 order-1 xl:order-2">
          <div className="card p-4">
            <MonthCalendar
              value={date}
              onChange={setDate}
              markedDates={markedDates}
              onMonthChange={loadMonth}
            />
            <p className="text-xs text-stone-400 mt-3 text-center">
              נקודה מתחת לתאריך מציינת יום עם תורים
            </p>
          </div>
          <div className="card p-4">
            <p className="font-display text-base font-bold text-stone-900 mb-3">חדרים</p>
            <ul className="space-y-2">
              {ROOM_KEYS.map((key) => (
                <li key={key} className="flex items-center gap-2 text-sm text-stone-600">
                  <span className={`w-3 h-3 rounded ${ROOM_ACCENTS[key].dot}`} />
                  {ROOM_LABELS[key]}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
