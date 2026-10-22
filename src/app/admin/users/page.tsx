"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { EmptyState, Loading, PageHeader } from "@/components/ui";
import { Pager, SortableTh, TableFilterBar, useTableFilters } from "@/components/table-filter";
import { buildListParams, clampPage, type FilterField } from "@/lib/table-filters";

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

/** DD/MM/YYYY לפי שעון ירושלים */
const joinDateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Asia/Jerusalem",
});

const PAGE_SIZE = 50;

const FILTER_FIELDS: FilterField[] = [
  { key: "name", label: "שם", type: "text" },
  { key: "email", label: "אימייל", type: "text", nullable: true },
  { key: "phone", label: "טלפון", type: "text", nullable: true },
  { key: "createdAt", label: "תאריך הצטרפות", type: "date" },
  { key: "appointments", label: "מספר תורים", type: "number" },
  {
    key: "role",
    label: "תפקיד",
    type: "select",
    options: [
      { value: "CLIENT", label: "לקוח" },
      { value: "ADMIN", label: "מנהל" },
    ],
  },
  {
    key: "status",
    label: "סטטוס",
    type: "select",
    options: (Object.keys(STATUS_LABELS) as UserRow["status"][]).map((value) => ({ value, label: STATUS_LABELS[value] })),
  },
];

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  idNumber: "",
  password: "",
  role: "CLIENT",
  status: "APPROVED",
};

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const filterState = useTableFilters();
  const { applied, sort, appliedKey, page, setPage } = filterState;
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdInfo, setCreatedInfo] = useState<{ name: string; email: string | null; password: string } | null>(null);

  // הסינון מתבצע בשרת על כל המשתמשים, לא רק על העמוד הנוכחי
  function load() {
    const params = buildListParams({ search: applied.search, filters: applied.filters, sort, page, pageSize: PAGE_SIZE });
    fetch(`/api/admin/users?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setUsers(Array.isArray(data?.users) ? data.users : []);
        const nextTotal = typeof data?.total === "number" ? data.total : 0;
        setTotal(nextTotal);
        // אחרי מחיקה/סינון העמוד עלול לא להתקיים — חוזרים לעמוד התקין האחרון
        if (clampPage(page, nextTotal, PAGE_SIZE) !== page) setPage(clampPage(page, nextTotal, PAGE_SIZE));
      });
  }

  useEffect(load, [appliedKey, page]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreating(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setCreating(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setFormError(data?.error ?? "שגיאה בהוספת המשתמש");
      return;
    }
    const created = await res.json();
    setCreatedInfo({ name: created.name, email: created.email, password: created.temporaryPassword });
    setForm(EMPTY_FORM);
    setShowForm(false);
    load();
  }

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

      <div className="mb-4">
        <TableFilterBar
          state={filterState}
          fields={FILTER_FIELDS}
          searchPlaceholder="חיפוש לפי שם, אימייל או טלפון..."
          searchLabel="חיפוש משתמשים"
          total={total}
          actions={
            <button onClick={() => setShowForm((v) => !v)} className="btn btn-primary">
              {showForm ? "ביטול" : "+ הוספת משתמש"}
            </button>
          }
        />
      </div>

      {createdInfo && (
        <div className="card p-5 mb-5 border border-brand-100 bg-brand-50/40" role="status">
          <p className="font-semibold text-stone-800 mb-2">המשתמש {createdInfo.name} נוצר בהצלחה</p>
          {createdInfo.email && (
            <p className="text-sm text-stone-600">
              אימייל: <span dir="ltr" className="font-mono">{createdInfo.email}</span>
            </p>
          )}
          <p className="text-sm text-stone-600 flex flex-wrap items-center gap-2">
            סיסמה זמנית:
            <span dir="ltr" className="font-mono text-base font-bold text-stone-900 select-all">{createdInfo.password}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(createdInfo.password)}
              className="btn btn-secondary btn-sm"
            >
              העתקה
            </button>
          </p>
          <p className="text-xs text-stone-500 mt-2">
            הסיסמה מוצגת רק עכשיו. בכניסה הראשונה המשתמש יידרש להחליף אותה.
          </p>
          <button type="button" onClick={() => setCreatedInfo(null)} className="btn btn-ghost btn-sm mt-2">
            סגירה
          </button>
        </div>
      )}

      {showForm && (
        <form onSubmit={createUser} className="card p-5 mb-5 grid gap-4 sm:grid-cols-2">
          <input
            required
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            placeholder="שם פרטי *"
            aria-label="שם פרטי"
            className="field"
          />
          <input
            required
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            placeholder="שם משפחה *"
            aria-label="שם משפחה"
            className="field"
          />
          <input
            type="email"
            dir="ltr"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="אימייל"
            aria-label="אימייל"
            className="field"
          />
          <input
            type="tel"
            dir="ltr"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="פלאפון"
            aria-label="פלאפון"
            className="field"
          />
          <input
            inputMode="numeric"
            dir="ltr"
            value={form.idNumber}
            onChange={(e) => setForm({ ...form, idNumber: e.target.value })}
            placeholder="תעודת זהות"
            aria-label="תעודת זהות"
            className="field"
          />
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="סיסמה זמנית (ריק = יצירה אוטומטית)"
            aria-label="סיסמה"
            className="field"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            aria-label="תפקיד"
            className="field"
          >
            <option value="CLIENT">לקוח</option>
            <option value="ADMIN">מנהל</option>
          </select>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            aria-label="סטטוס"
            className="field"
          >
            <option value="APPROVED">מאושר</option>
            <option value="PENDING">ממתין לאישור</option>
            <option value="BLOCKED">חסום</option>
          </select>
          <p className="sm:col-span-2 text-xs text-stone-500">
            יש להזין אימייל או פלאפון (ההתחברות היא באמצעות אימייל). הסיסמה תוצג לך לאחר היצירה, והמשתמש יחליף אותה בכניסה הראשונה.
          </p>
          {formError && <p className="sm:col-span-2 text-sm text-red-700">{formError}</p>}
          <div className="sm:col-span-2">
            <button type="submit" disabled={creating} className="btn btn-primary">
              {creating ? "שומר..." : "הוספה"}
            </button>
          </div>
        </form>
      )}

      {users === null ? (
        <Loading />
      ) : users.length === 0 ? (
        <EmptyState icon="users">
          {filterState.active.length > 0 || applied.search ? "לא נמצאו משתמשים התואמים לחיפוש ולמסננים." : "אין משתמשים עדיין."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <SortableTh label="שם" sortKey="name" state={filterState} />
                <SortableTh label="אימייל" sortKey="email" state={filterState} />
                <SortableTh label="טלפון" sortKey="phone" state={filterState} />
                <SortableTh label="תאריך הצטרפות" sortKey="createdAt" state={filterState} />
                <SortableTh label="תורים" sortKey="appointments" state={filterState} />
                <SortableTh label="תפקיד" sortKey="role" state={filterState} />
                <SortableTh label="סטטוס" sortKey="status" state={filterState} />
                <th>פעולות</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link
                      href={`/admin/users/${u.id}`}
                      title="פתיחת כרטיס משתמש"
                      className="flex items-center gap-2.5 font-semibold text-stone-800 whitespace-nowrap hover:text-brand-700 hover:underline"
                    >
                      <span className="w-9 h-9 rounded-full bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 ring-1 ring-bronze-200 text-xs font-bold flex items-center justify-center shrink-0">
                        {u.name.trim().charAt(0)}
                      </span>
                      {u.name}
                    </Link>
                  </td>
                  <td className="text-stone-500">{u.email ?? "נרשם/ה דרך הטלפון"}</td>
                  <td className="text-stone-500 tabular-nums whitespace-nowrap">{u.phone ?? "—"}</td>
                  <td className="text-stone-500 tabular-nums whitespace-nowrap">{joinDateFmt.format(new Date(u.createdAt))}</td>
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
      {total !== null && <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />}
    </div>
  );
}
