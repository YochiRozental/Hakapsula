"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status = "PENDING" | "APPROVED" | "BLOCKED";

export function UserActions({ id, name, status, isSelf }: { id: string; name: string; status: Status; isSelf: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(next: Status) {
    setBusy(true);
    await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    router.refresh();
  }

  async function remove() {
    if (!confirm(`למחוק את ${name}? יימחקו גם כל התורים שלו/שלה. פעולה זו בלתי הפיכה.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error ?? "שגיאה במחיקת המשתמש");
      setBusy(false);
      return;
    }
    router.push("/admin/users");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status !== "APPROVED" && (
        <button onClick={() => setStatus("APPROVED")} disabled={busy} className="btn btn-primary btn-sm">
          {status === "BLOCKED" ? "ביטול חסימה" : "אישור"}
        </button>
      )}
      {status !== "BLOCKED" && (
        <button onClick={() => setStatus("BLOCKED")} disabled={busy || isSelf} className="btn btn-danger btn-sm">
          חסימה
        </button>
      )}
      <button onClick={remove} disabled={busy || isSelf} className="btn btn-ghost btn-sm text-red-700! hover:bg-red-50!">
        מחיקה
      </button>
    </div>
  );
}
