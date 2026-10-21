"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Alert, AuthShell, Icon, SectionTitle } from "@/components/ui";
import { safeInternalPath } from "@/lib/safe-path";

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  idNumber: "",
  gender: "",
  cardNumber: "",
  cardExpiry: "",
  cardCvv: "",
  password: "",
};

/** מקבץ את מספר הכרטיס לרביעיות: 1234 5678 9012 3456 */
function formatCardNumber(value: string) {
  return value.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** מוסיף לוכסן אוטומטית לתוקף: MM/YY */
function formatExpiry(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl");
  const [form, setForm] = useState(EMPTY_FORM);
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

      // מגיעים מתהליך הזמנה — חוזרים אליו; אחרת למסך הסטטוס
      router.push(safeInternalPath(callbackUrl, "/account-status"));
      router.refresh();
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setLoading(false);
    }
  }

  return (
    <AuthShell title="הרשמה למערכת" subtitle="שדות המסומנים בכוכבית (*) הם שדות חובה">
      <form onSubmit={handleSubmit} className="space-y-5">
        <SectionTitle index="1">פרטים אישיים</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-first-name" className="field-label">שם פרטי</label>
            <input
              id="reg-first-name"
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="reg-last-name" className="field-label">שם משפחה</label>
            <input
              id="reg-last-name"
              autoComplete="family-name"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="field"
            />
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-phone" className="field-label">פלאפון</label>
            <input
              id="reg-phone"
              type="tel"
              dir="ltr"
              autoComplete="tel"
              placeholder="050-1234567"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="field text-right"
            />
          </div>
          <div>
            <label htmlFor="reg-id-number" className="field-label">מספר זהות</label>
            <input
              id="reg-id-number"
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              pattern="\d{5,9}"
              title="מספר זהות בן 9 ספרות"
              value={form.idNumber}
              onChange={(e) => setForm({ ...form, idNumber: e.target.value.replace(/\D/g, "") })}
              className="field text-right tabular-nums"
            />
          </div>
        </div>
        <div>
          <span className="field-label">מגדר</span>
          <div className="flex gap-6" role="radiogroup" aria-label="מגדר">
            {[
              { value: "MALE", label: "זכר" },
              { value: "FEMALE", label: "נקבה" },
            ].map((o) => (
              <label key={o.value} className="inline-flex items-center gap-2 text-sm text-stone-800 cursor-pointer">
                <input
                  type="radio"
                  name="gender"
                  required
                  value={o.value}
                  checked={form.gender === o.value}
                  onChange={() => setForm({ ...form, gender: o.value })}
                />
                {o.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-stone-400 mt-1.5">נדרש לצורך התאמת שעות בנים / בנות</p>
        </div>
        <div>
          <label htmlFor="reg-email" className="field-label">אימייל *</label>
          <input
            id="reg-email"
            required
            type="email"
            dir="ltr"
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="field text-right"
          />
        </div>
        <div>
          <label htmlFor="reg-password" className="field-label">סיסמה *</label>
          <input
            id="reg-password"
            required
            type="password"
            minLength={4}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="field"
          />
          <p className="text-xs text-stone-400 mt-1.5">לפחות 4 תווים</p>
        </div>

        <div className="hairline-bronze" />

        <SectionTitle index="2" hint="מספר הכרטיס המלא וה-CVV אינם נשמרים במערכת">
          פרטי אשראי
        </SectionTitle>
        <div>
          <label htmlFor="reg-card-number" className="field-label">מספר כרטיס אשראי</label>
          <div className="relative">
            <input
              id="reg-card-number"
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-number"
              placeholder="0000 0000 0000 0000"
              value={form.cardNumber}
              onChange={(e) => setForm({ ...form, cardNumber: formatCardNumber(e.target.value) })}
              className="field text-right tabular-nums ps-10"
            />
            <Icon
              name="card"
              className="w-5 h-5 text-stone-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-5">
          <div>
            <label htmlFor="reg-card-expiry" className="field-label">תוקף</label>
            <input
              id="reg-card-expiry"
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-exp"
              placeholder="MM/YY"
              pattern="\d{2}/\d{2}"
              title="תוקף בפורמט MM/YY"
              value={form.cardExpiry}
              onChange={(e) => setForm({ ...form, cardExpiry: formatExpiry(e.target.value) })}
              className="field text-right tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="reg-card-cvv" className="field-label">
              CVV <span className="font-normal text-stone-400">(3 ספרות בגב הכרטיס)</span>
            </label>
            <input
              id="reg-card-cvv"
              type="password"
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-csc"
              maxLength={3}
              pattern="\d{3}"
              title="3 ספרות"
              value={form.cardCvv}
              onChange={(e) => setForm({ ...form, cardCvv: e.target.value.replace(/\D/g, "") })}
              className="field text-right tabular-nums"
            />
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button type="submit" disabled={loading} className="btn btn-primary w-full py-3!">
          {loading ? "נרשם..." : "הרשמה"}
        </button>

        <p className="text-sm text-stone-500 text-center">
          כבר יש לך חשבון?{" "}
          <Link
            href={callbackUrl ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/login"}
            className="text-brand-700 font-semibold hover:underline"
          >
            התחברות
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
