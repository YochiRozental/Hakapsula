"use client";

import { useEffect, useState } from "react";
import { ROOM_KEYS, ROOM_LABELS } from "@/lib/rooms";
import { buildTimeOptions, combineDateAndTime, todayIsoDate, DURATION_OPTIONS } from "@/lib/slots";
import { fitsOpening, isClosedDate, parseTimeOption } from "@/lib/opening-hours";
import { useDayHours } from "@/lib/use-day-hours";
import { DayHours } from "@/components/hours-summary";
import type { RoomKey } from "@/generated/prisma/client";
import { Alert, EmptyState, Icon, Loading, PageHeader, ROOM_ACCENTS, SectionTitle } from "@/components/ui";
import { Pager, SortableTh, TableFilterBar, useTableFilters } from "@/components/table-filter";
import { buildListParams, clampPage, type Filter, type FilterField } from "@/lib/table-filters";
import { jerusalemTodayIso } from "@/lib/jerusalem-time";

type Appointment = {
  id: string;
  startTime: string;
  endTime: string;
  status: "CONFIRMED" | "CANCELLED";
  notes: string | null;
  source: "WEB" | "IVR" | "ADMIN" | "SHIFT";
  room: { key: RoomKey; name: string };
  user: { id: string; name: string; email: string | null; phone: string | null };
};

type UserOption = { id: string; name: string; email: string | null; phone: string | null };

const TIME_OPTIONS = buildTimeOptions();
const PAGE_SIZE = 50;

const FILTER_FIELDS: FilterField[] = [
  { key: "startTime", label: "תאריך התור", type: "date" },
  {
    key: "room",
    label: "חדר",
    type: "select",
    options: ROOM_KEYS.map((key) => ({ value: key, label: ROOM_LABELS[key] })),
  },
  {
    key: "status",
    label: "סטטוס",
    type: "select",
    options: [
      { value: "CONFIRMED", label: "מאושר" },
      { value: "CANCELLED", label: "מבוטל" },
    ],
  },
  {
    key: "source",
    label: "מקור",
    type: "select",
    options: [
      { value: "WEB", label: "אתר" },
      { value: "ADMIN", label: "ניהול" },
      { value: "IVR", label: "IVR" },
      { value: "SHIFT", label: "משמרת" },
    ],
  },
  { key: "userName", label: "שם לקוח", type: "text" },
  { key: "userEmail", label: "אימייל לקוח", type: "text", nullable: true },
  { key: "userPhone", label: "טלפון לקוח", type: "text", nullable: true },
  { key: "notes", label: "הערות", type: "text", nullable: true },
  { key: "createdAt", label: "תאריך יצירה", type: "date" },
];

/** ברירת המחדל כמו קודם: תורי היום. אפשר להסיר את התגית כדי לראות את כל התורים */
function defaultFilters(): Record<string, Filter> {
  const today = jerusalemTodayIso();
  return { startTime: { key: "startTime", op: "between", value: today, value2: today } };
}

export default function AdminAppointmentsPage() {
  const filterState = useTableFilters(defaultFilters());
  const { applied, sort, appliedKey, page, setPage } = filterState;
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [newRoomKey, setNewRoomKey] = useState<RoomKey>("ROOM1");
  const [newDate, setNewDate] = useState(todayIsoDate());
  const [newTime, setNewTime] = useState("08:00");
  const [timeTouched, setTimeTouched] = useState(false);
  const [newDuration, setNewDuration] = useState(30);
  const [newNotes, setNewNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // שעות הפעילות של התאריך הנבחר (מקור מרכזי). שבת סגורה לכולם; מחוץ לשעות בימי חול המנהל רשאי לקבוע (חריג)
  const { day: newDayHours } = useDayHours(newDate);
  const saturdayClosed = isClosedDate(newDate);
  // יום סגור (שבת, או יום שהוגדר כסגור בשעות הפעילות) חוסם גם מנהל; שעות מחוץ לפעילות בימי פעילות — מותר למנהל
  const dayClosed = saturdayClosed || !!newDayHours?.closed;
  const insideHours = (t: string) =>
    !!newDayHours && fitsOpening(newDayHours, parseTimeOption(t), parseTimeOption(t) + newDuration);
  const openOptions = TIME_OPTIONS.filter(insideHours);
  const outsideOptions = TIME_OPTIONS.filter((t) => !insideHours(t));
  // כל עוד המנהל לא בחר שעה בעצמו — ברירת המחדל היא תחילת החלון הפתוח הראשון (כשיש)
  const time = timeTouched ? newTime : (openOptions[0] ?? newTime);
  const selectedOutside = !!newDayHours && !dayClosed && !insideHours(time);

  // הסינון מתבצע בשרת על כל התורים, לא רק על העמוד הנוכחי
  function loadAppointments() {
    const params = buildListParams({ search: applied.search, filters: applied.filters, sort, page, pageSize: PAGE_SIZE });
    fetch(`/api/admin/appointments?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setAppointments(Array.isArray(data?.appointments) ? data.appointments : []);
        const nextTotal = typeof data?.total === "number" ? data.total : 0;
        setTotal(nextTotal);
        // אחרי מחיקה/ביטול/סינון העמוד עלול לא להתקיים — חוזרים לעמוד התקין האחרון
        if (clampPage(page, nextTotal, PAGE_SIZE) !== page) setPage(clampPage(page, nextTotal, PAGE_SIZE));
      });
  }

  useEffect(loadAppointments, [appliedKey, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handle = setTimeout(() => {
      if (userSearch.trim().length < 2) {
        setUserOptions([]);
        return;
      }
      fetch(`/api/admin/users?search=${encodeURIComponent(userSearch)}`)
        .then((res) => res.json())
        .then((data) => setUserOptions(Array.isArray(data) ? data : []));
    }, 300);
    return () => clearTimeout(handle);
  }, [userSearch]);

  async function handleCancel(id: string) {
    setCancellingId(id);
    await fetch(`/api/appointments/${id}`, { method: "DELETE" });
    setCancellingId(null);
    loadAppointments();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!selectedUserId) {
      setFormError("יש לבחור לקוח קיים (חיפוש לפי אימייל או שם)");
      return;
    }
    setFormSubmitting(true);

    const start = combineDateAndTime(newDate, time);
    const end = new Date(start.getTime() + newDuration * 60000);

    try {
      const res = await fetch("/api/admin/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selectedUserId,
          roomKey: newRoomKey,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          notes: newNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? "שגיאה בקביעת התור");
        return;
      }
      setShowForm(false);
      setSelectedUserId("");
      setUserSearch("");
      setNewNotes("");
      loadAppointments();
    } finally {
      setFormSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="תפעול"
        title="ניהול תורים"
        subtitle="צפייה, סינון, ביטול וקביעה ידנית של תורים"
        actions={
          <button
            onClick={() => setShowForm((v) => !v)}
            className={`btn ${showForm ? "btn-secondary" : "btn-primary"}`}
          >
            <Icon name={showForm ? "x" : "plus"} className="w-4 h-4" />
            {showForm ? "ביטול" : "קביעת תור ידנית"}
          </button>
        }
      />

      <TableFilterBar
        state={filterState}
        fields={FILTER_FIELDS}
        searchPlaceholder="חיפוש לפי לקוח, טלפון, חדר או הערות..."
        searchLabel="חיפוש תורים"
        total={total}
      />

      {showForm && (
        <form onSubmit={handleCreate} className="card p-5 sm:p-6 space-y-5">
          <SectionTitle>קביעת תור ידנית</SectionTitle>
          <div>
            <label htmlFor="new-user" className="field-label">חיפוש לקוח (שם, אימייל או טלפון)</label>
            <input
              id="new-user"
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setSelectedUserId("");
              }}
              placeholder="לדוגמה: israel@example.com או 0501234567"
              className="field"
            />
            {userOptions.length > 0 && !selectedUserId && (
              <ul className="mt-1.5 card shadow-lift divide-y divide-cream-100 max-h-48 overflow-auto">
                {userOptions.map((u) => (
                  <li
                    key={u.id}
                    onClick={() => {
                      setSelectedUserId(u.id);
                      setUserSearch(`${u.name} (${u.email ?? u.phone ?? "טלפון"})`);
                      setUserOptions([]);
                    }}
                    className="px-4 py-2.5 text-sm hover:bg-brand-50 cursor-pointer"
                  >
                    <span className="font-semibold text-stone-800">{u.name}</span>
                    <span className="text-stone-500"> · {u.email ?? u.phone ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            {selectedUserId && (
              <p className="text-xs text-brand-700 font-semibold mt-1.5 flex items-center gap-1">
                <Icon name="check" className="w-3.5 h-3.5" />
                לקוח נבחר
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label htmlFor="new-room" className="field-label">חדר</label>
              <select
                id="new-room"
                value={newRoomKey}
                onChange={(e) => setNewRoomKey(e.target.value as RoomKey)}
                className="field"
              >
                {ROOM_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {ROOM_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="new-duration" className="field-label">משך</label>
              <select
                id="new-duration"
                value={newDuration}
                onChange={(e) => setNewDuration(Number(e.target.value))}
                className="field"
              >
                {DURATION_OPTIONS.map((opt) => (
                  <option key={opt.minutes} value={opt.minutes}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="new-date" className="field-label">תאריך</label>
              <input
                id="new-date"
                type="date"
                value={newDate}
                onChange={(e) => {
                  setNewDate(e.target.value);
                  setTimeTouched(false);
                }}
                className="field"
              />
            </div>
            <div>
              <label htmlFor="new-time" className="field-label">שעה</label>
              <select
                id="new-time"
                value={time}
                onChange={(e) => {
                  setNewTime(e.target.value);
                  setTimeTouched(true);
                }}
                disabled={dayClosed}
                className="field"
              >
                {dayClosed ? (
                  <option value={time}>{time}</option>
                ) : (
                  <>
                    {openOptions.length > 0 && (
                      <optgroup label="בשעות הפעילות">
                        {openOptions.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="מחוץ לשעות הפעילות (חריג מנהל)">
                      {outsideOptions.map((t) => (
                        <option key={t} value={t}>
                          {t} · מחוץ לפעילות
                        </option>
                      ))}
                    </optgroup>
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="rounded-xl bg-cream-50 ring-1 ring-cream-200 px-4 py-3 space-y-2" aria-live="polite">
            <p className="text-sm font-semibold text-stone-600">שעות הפעילות בתאריך הנבחר:</p>
            {dayClosed ? (
              <p className="text-sm font-semibold text-red-700">
                {saturdayClosed ? "יום שבת סגור" : "היום הוגדר כסגור"} — לא ניתן לקבוע בו תור, גם למנהל.
              </p>
            ) : newDayHours ? (
              <>
                <DayHours day={newDayHours} />
                {selectedOutside && (
                  <p className="text-sm font-semibold text-amber-800">
                    השעה שנבחרה מחוץ לשעות הפעילות. כמנהל אפשר לקבוע בה תור (חריג).
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-stone-500">טוען...</p>
            )}
          </div>

          <div>
            <label htmlFor="new-notes" className="field-label">הערות</label>
            <input
              id="new-notes"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              className="field"
            />
          </div>

          {formError && <Alert tone="error">{formError}</Alert>}

          <button type="submit" disabled={formSubmitting || dayClosed} className="btn btn-primary">
            {formSubmitting ? "קובע..." : "קביעת תור"}
          </button>
        </form>
      )}

      <div>
        {appointments === null ? (
          <Loading />
        ) : appointments.length === 0 ? (
          <EmptyState>
            {filterState.active.length > 0 || applied.search ? "לא נמצאו תורים התואמים לחיפוש ולמסננים." : "אין תורים עדיין."}
          </EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <SortableTh label="תאריך" sortKey="startTime" state={filterState} />
                  <th>שעה</th>
                  <SortableTh label="חדר" sortKey="room" state={filterState} />
                  <SortableTh label="לקוח" sortKey="userName" state={filterState} />
                  <SortableTh label="טלפון" sortKey="userPhone" state={filterState} />
                  <SortableTh label="מקור" sortKey="source" state={filterState} />
                  <SortableTh label="סטטוס" sortKey="status" state={filterState} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((a) => (
                  <tr key={a.id} className={a.status === "CANCELLED" ? "opacity-55" : ""}>
                    <td className="whitespace-nowrap tabular-nums text-stone-600">
                      {new Date(a.startTime).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" })}
                    </td>
                    <td className="whitespace-nowrap font-semibold text-stone-800 tabular-nums">
                      {new Date(a.startTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                      {" – "}
                      {new Date(a.endTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${ROOM_ACCENTS[a.room.key].dot}`} />
                        {ROOM_LABELS[a.room.key]}
                      </span>
                    </td>
                    <td>
                      <span className="font-semibold text-stone-800">{a.user.name}</span>
                      <div className="text-xs text-stone-400">{a.user.email ?? "—"}</div>
                    </td>
                    <td className="tabular-nums whitespace-nowrap text-stone-600">{a.user.phone ?? "—"}</td>
                    <td>
                      <span className="badge bg-cream-100 text-stone-600">
                        {a.source === "WEB" ? "אתר" : a.source === "ADMIN" ? "ניהול" : a.source === "SHIFT" ? "משמרת" : "IVR"}
                      </span>
                    </td>
                    <td>
                      {a.status === "CONFIRMED" ? (
                        <span className="badge bg-brand-50 text-brand-700">מאושר</span>
                      ) : (
                        <span className="badge bg-red-50 text-red-600">מבוטל</span>
                      )}
                    </td>
                    <td>
                      {a.status === "CONFIRMED" && (
                        <button
                          onClick={() => handleCancel(a.id)}
                          disabled={cancellingId === a.id}
                          className="btn btn-danger btn-sm"
                        >
                          {cancellingId === a.id ? "מבטל..." : "ביטול"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total !== null && <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />}
      </div>
    </div>
  );
}
