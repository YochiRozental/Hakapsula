"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Alert, AuthShell } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/booking";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("אימייל או סיסמה שגויים");
      setLoading(false);
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <AuthShell title="התחברות" subtitle="ברוכים השבים! התחברו כדי לקבוע ולנהל תורים.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="login-email" className="field-label">אימייל</label>
          <input
            id="login-email"
            required
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field text-right"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="field-label">סיסמה</label>
          <input
            id="login-password"
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "מתחבר..." : "התחברות"}
        </button>

        <p className="text-sm text-stone-500 text-center">
          אין לך חשבון?{" "}
          <Link
            href={searchParams.has("callbackUrl") ? `/register?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/register"}
            className="text-brand-700 font-semibold hover:underline"
          >
            הרשמה
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
