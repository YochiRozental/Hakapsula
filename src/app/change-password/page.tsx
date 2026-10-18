"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Alert, AuthShell } from "@/components/ui";

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("הסיסמאות אינן תואמות");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "שגיאה בהחלפת הסיסמה");
      setLoading(false);
      return;
    }
    // ה-JWT עדיין מסמן שנדרשת החלפה, לכן מתחברים מחדש עם הסיסמה החדשה
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <AuthShell title="החלפת סיסמה" subtitle="נכנסת עם סיסמה זמנית. כדי להמשיך, בחר/י סיסמה חדשה.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="cp-current" className="field-label">סיסמה זמנית</label>
          <input
            id="cp-current"
            required
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="cp-new" className="field-label">סיסמה חדשה</label>
          <input
            id="cp-new"
            required
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="cp-confirm" className="field-label">אימות סיסמה חדשה</label>
          <input
            id="cp-confirm"
            required
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="field"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "שומר..." : "החלפת סיסמה"}
        </button>
      </form>
    </AuthShell>
  );
}
