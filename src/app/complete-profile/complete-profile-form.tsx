"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AuthShell, Icon, SectionTitle } from "@/components/ui";

/** מקבץ את מספר הכרטיס לרביעיות: 1234 5678 9012 3456 */
function formatCardNumber(value: string) {
  return value
    .replace(/\D/g, "")
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** מוסיף לוכסן אוטומטית לתוקף: MM/YY */
function formatExpiry(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2
    ? `${digits.slice(0, 2)}/${digits.slice(2)}`
    : digits;
}

type Props = {
  nextPath: string;
  isEdit?: boolean;
  initial: {
    firstName: string;
    lastName: string;
    phone: string;
    idNumber: string;
    gender: string;
    cardExpiry: string;
  };
  cardLast4: string | null;
};

export function CompleteProfileForm({
  nextPath,
  isEdit = false,
  initial,
  cardLast4,
}: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ ...initial, cardNumber: "", cardCvv: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // כרטיס שכבר שמור אינו חובה להזין מחדש; כרטיס חדש מחייב גם CVV
  const hasSavedCard = !!cardLast4;
  const enteringNewCard = form.cardNumber !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה בשמירת הפרטים");
        setLoading(false);
        return;
      }

      // חזרה לתהליך ההזמנה המקורי — בחירת החדר והמועד נשמרת בדפדפן
      router.push(nextPath);
      router.refresh();
    } catch {
      setError("שגיאה בלתי צפויה, נסה שוב");
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={isEdit ? "עריכת פרטים" : "השלמת פרטים"}
      subtitle={
        isEdit
          ? "עדכון הפרטים האישיים ופרטי האשראי שלך."
          : "כדי להזמין חדר יש להשלים את הפרטים הבאים. בחירת החדר והמועד נשמרת."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <SectionTitle index="1">פרטים אישיים</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="cp-first-name" className="field-label">
              שם פרטי
            </label>
            <input
              id="cp-first-name"
              required
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="cp-last-name" className="field-label">
              שם משפחה
            </label>
            <input
              id="cp-last-name"
              required
              autoComplete="family-name"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="field"
            />
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="cp-phone" className="field-label">
              פלאפון
            </label>
            <input
              id="cp-phone"
              required
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
            <label htmlFor="cp-id-number" className="field-label">
              מספר זהות
            </label>
            <input
              id="cp-id-number"
              required
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              pattern="\d{5,9}"
              title="מספר זהות בן 9 ספרות"
              value={form.idNumber}
              onChange={(e) =>
                setForm({
                  ...form,
                  idNumber: e.target.value.replace(/\D/g, ""),
                })
              }
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
              <label
                key={o.value}
                className="inline-flex items-center gap-2 text-sm text-stone-800 cursor-pointer"
              >
                <input
                  type="radio"
                  name="gender"
                  value={o.value}
                  checked={form.gender === o.value}
                  onChange={() => setForm({ ...form, gender: o.value })}
                />
                {o.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-stone-400 mt-1.5">
            נדרש לצורך התאמת שעות בנים / בנות
          </p>
        </div>

        <div className="hairline-bronze" />

        <SectionTitle
          index="2"
          hint="מספר הכרטיס המלא וה-CVV אינם נשמרים במערכת"
        >
          פרטי אשראי
        </SectionTitle>
        <div>
          <label htmlFor="cp-card-number" className="field-label">
            מספר כרטיס אשראי
          </label>
          <div className="relative">
            <input
              id="cp-card-number"
              required={!hasSavedCard}
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-number"
              placeholder={
                hasSavedCard
                  ? `•••• •••• •••• ${cardLast4}`
                  : "0000 0000 0000 0000"
              }
              value={form.cardNumber}
              onChange={(e) =>
                setForm({
                  ...form,
                  cardNumber: formatCardNumber(e.target.value),
                })
              }
              className="field text-right tabular-nums ps-10"
            />
            <Icon
              name="card"
              className="w-5 h-5 text-stone-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            />
          </div>
          {hasSavedCard && (
            <p className="text-xs text-stone-400 mt-1.5">
              כרטיס שמסתיים ב-{cardLast4} שמור בחשבון. להחלפה — הזינו מספר כרטיס
              חדש.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-5">
          <div>
            <label htmlFor="cp-card-expiry" className="field-label">
              תוקף
            </label>
            <input
              id="cp-card-expiry"
              required
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-exp"
              placeholder="MM/YY"
              pattern="\d{2}/\d{2}"
              title="תוקף בפורמט MM/YY"
              value={form.cardExpiry}
              onChange={(e) =>
                setForm({ ...form, cardExpiry: formatExpiry(e.target.value) })
              }
              className="field text-right tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="cp-card-cvv" className="field-label">
              CVV{" "}
              <span className="font-normal text-stone-400">
                (3 ספרות בגב הכרטיס)
              </span>
            </label>
            <input
              id="cp-card-cvv"
              required={enteringNewCard}
              type="password"
              inputMode="numeric"
              dir="ltr"
              autoComplete="cc-csc"
              maxLength={3}
              pattern="\d{3}"
              title="3 ספרות"
              value={form.cardCvv}
              onChange={(e) =>
                setForm({ ...form, cardCvv: e.target.value.replace(/\D/g, "") })
              }
              className="field text-right tabular-nums"
            />
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <button
          type="submit"
          disabled={loading}
          className="btn btn-primary w-full py-3!"
        >
          {loading ? "שומר..." : isEdit ? "שמירה" : "שמירה והמשך להזמנה"}
        </button>
      </form>
    </AuthShell>
  );
}
