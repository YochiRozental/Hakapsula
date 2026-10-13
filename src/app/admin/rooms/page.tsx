"use client";

import { useEffect, useState } from "react";
import type { RoomKey } from "@/generated/prisma/client";
import { Loading, PageHeader, RoomTile, RoomVisual } from "@/components/ui";

type Room = {
  id: string;
  key: RoomKey;
  name: string;
  description: string | null;
  isCombo: boolean;
  active: boolean;
};

export default function AdminRoomsPage() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  function load() {
    fetch("/api/admin/rooms")
      .then((res) => res.json())
      .then((data) => setRooms(Array.isArray(data) ? data : []));
  }

  useEffect(load, []);

  async function toggleActive(room: Room) {
    setSavingId(room.id);
    await fetch(`/api/admin/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !room.active }),
    });
    setSavingId(null);
    load();
  }

  return (
    <div>
      <PageHeader eyebrow="החללים שלנו" title="ניהול חדרים" subtitle="הפעלה והשבתה של חדרי הקליניקה" />
      {rooms === null ? (
        <Loading />
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {rooms.map((room) => (
            <div key={room.id} className="card card-hover overflow-hidden flex flex-col">
              <RoomVisual roomKey={room.key} className={`h-32 ${room.active ? "" : "grayscale opacity-70"}`} />
              <div className="p-5 flex flex-col gap-4">
              <div className="flex items-start gap-4">
                <RoomTile roomKey={room.key} className="w-12 h-12 -mt-11 ring-4! ring-white! shadow-lift" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-lg font-bold text-stone-900">{room.name}</p>
                    <span
                      className={`badge ${room.active ? "bg-brand-50 text-brand-700" : "bg-red-50 text-red-600"}`}
                    >
                      {room.active ? "פעיל" : "מושבת"}
                    </span>
                  </div>
                  {room.description && <p className="text-sm text-stone-500 mt-1">{room.description}</p>}
                  {room.isCombo && (
                    <p className="text-xs text-gold-600 bg-gold-100 rounded-lg px-2.5 py-1.5 mt-2">
                      חדר משולב — חוסם את החדרים המרכיבים אותו בזמן ההזמנה
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-cream-100 pt-4">
                <span className="text-sm text-stone-500">
                  {room.active ? "לחץ להשבתת החדר" : "לחץ להפעלת החדר"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={room.active}
                  aria-label={room.active ? "השבתת החדר" : "הפעלת החדר"}
                  onClick={() => toggleActive(room)}
                  disabled={savingId === room.id}
                  className={`relative w-12 h-7 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                    room.active ? "bg-linear-to-b from-brand-500 to-brand-700 shadow-brand" : "bg-cream-300"
                  }`}
                >
                  <span
                    className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${
                      room.active ? "right-1" : "right-6"
                    }`}
                  />
                </button>
              </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
