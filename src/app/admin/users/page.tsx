"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Icon, Loading, PageHeader } from "@/components/ui";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: "CLIENT" | "ADMIN";
  status: "PENDING" | "APPROVED" | "BLOCKED";
  createdAt: string;
  _count: { appointments: number };
};

const STATUS_LABELS: Record<UserRow["status"], string> = {
  PENDING: "ממתין לאישור",
  APPROVED: "מאושר",
  BLOCKED: "חסום",
};

const STATUS_CLASSES: Record<UserRow["status"], string> = {
  PENDING: "bg-gold-100 text-gold-600",
  APPROVED: "bg-brand-50 text-brand-700",
  BLOCKED: "bg-red-50 text-red-700",
};

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  function load() {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    fetch(`/api/admin/users${params}`)
      .then((res) => res.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []));
  }

  useEffect(() => {
    const handle = setTimeout(load, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function setStatus(user: UserRow, status: UserRow["status"]) {
    setSavingId(user.id);
    await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSavingId(null);
    load();
  }

  async function deleteUser(user: UserRow) {
    const warning =
      user._count.appointments > 0
        ? `למחוק את ${user.name}? יימחקו גם ${user._count.appointments} התורים שלו/שלה. פעולה זו בלתי הפיכה.`
        : `למחוק את ${user.name}? פעולה זו בלתי הפיכה.`;
    if (!confirm(warning)) return;

    setSavingId(user.id);
    const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    setSavingId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error ?? "שגיאה במחיקת המשתמש");
      return;
    }
    load();
  }

  return (
    <div>
      <PageHeader eyebrow="לקוחות ומנהלים" title="ניהול משתמשים" subtitle="אישור, חסימה ומחיקה של משתמשי המערכת" />

      <div className="relative max-w-sm mb-4">
        <Icon name="search" className="w-4 h-4 text-stone-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי שם או אימייל..."
          aria-label="חיפוש משתמשים"
          className="field bg-white! pr-10!"
        />
      </div>

      {users === null ? (
        <Loading />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>שם</th>
                <th>אימייל</th>
                <th>טלפון</th>
                <th>תורים</th>
                <th>תפקיד</th>
                <th>סטטוס</th>
                <th>פעולות</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="flex items-center gap-2.5 font-semibold text-stone-800 whitespace-nowrap">
                      <span className="w-9 h-9 rounded-full bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 ring-1 ring-bronze-200 text-xs font-bold flex items-center justify-center shrink-0">
                        {u.name.trim().charAt(0)}
                      </span>
                      {u.name}
                    </span>
                  </td>
                  <td className="text-stone-500">{u.email ?? "נרשם/ה דרך הטלפון"}</td>
                  <td className="text-stone-500 tabular-nums whitespace-nowrap">{u.phone ?? "—"}</td>
                  <td className="tabular-nums">{u._count.appointments}</td>
                  <td>
                    <span
                      className={`badge ${
                        u.role === "ADMIN" ? "bg-brand-50 text-brand-700" : "bg-cream-100 text-stone-600"
                      }`}
                    >
                      {u.role === "ADMIN" ? "מנהל" : "לקוח"}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASSES[u.status]}`}>{STATUS_LABELS[u.status]}</span>
                  </td>
                  <td className="whitespace-nowrap">
                    {u.status === "PENDING" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setStatus(u, "APPROVED")}
                          disabled={savingId === u.id}
                          className="btn btn-primary btn-sm"
                        >
                          אישור
                        </button>
                        <button
                          onClick={() => setStatus(u, "BLOCKED")}
                          disabled={savingId === u.id || u.id === session?.user?.id}
                          className="btn btn-danger btn-sm"
                        >
                          חסימה
                        </button>
                      </div>
                    )}
                    {u.status === "APPROVED" && (
                      <button
                        onClick={() => setStatus(u, "BLOCKED")}
                        disabled={savingId === u.id || u.id === session?.user?.id}
                        className="btn btn-danger btn-sm"
                      >
                        חסימה
                      </button>
                    )}
                    {u.status === "BLOCKED" && (
                      <button
                        onClick={() => setStatus(u, "APPROVED")}
                        disabled={savingId === u.id}
                        className="btn btn-secondary btn-sm"
                      >
                        ביטול חסימה
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => deleteUser(u)}
                      disabled={savingId === u.id || u.id === session?.user?.id}
                      className="btn btn-ghost btn-sm text-red-700! hover:bg-red-50!"
                    >
                      מחיקה
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
