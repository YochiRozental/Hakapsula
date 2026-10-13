"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Alert, AuthShell } from "@/components/ui";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה בהרשמה");
        setLoading(false);
        return;
      }

      const signInResult = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });

      if (signInResult?.error) {
        router.push("/login");
        return;
      }

      router.push("/account-status");
      router.refresh();
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setLoading(false);
    }
  }

  return (
    <AuthShell title="הרשמה למערכת" subtitle="פתחו חשבון כדי לקבוע תורים לחדרי הקליניקה.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="reg-name" className="field-label">שם מלא</label>
          <input
            id="reg-name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="field"
          />
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-email" className="field-label">אימייל</label>
            <input
              id="reg-email"
              required
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="field text-right"
            />
          </div>
          <div>
            <label htmlFor="reg-phone" className="field-label">
              טלפון <span className="font-normal text-stone-400">(לא חובה)</span>
            </label>
            <input
              id="reg-phone"
              type="tel"
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="field text-right"
            />
          </div>
        </div>
        <div>
          <label htmlFor="reg-password" className="field-label">סיסמה</label>
          <input
            id="reg-password"
            required
            type="password"
            minLength={4}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="field"
          />
          <p className="text-xs text-stone-400 mt-1.5">לפחות 4 תווים</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "נרשם..." : "הרשמה"}
        </button>

        <p className="text-sm text-stone-500 text-center">
          כבר יש לך חשבון?{" "}
          <Link href="/login" className="text-brand-700 font-semibold hover:underline">
            התחברות
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
