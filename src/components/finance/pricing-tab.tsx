"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Loading, SectionTitle } from "@/components/ui";
import { api, useSingleFlight } from "@/lib/payments/client";
import { fmtDateTime } from "@/components/finance/bits";
import { WindowsTab } from "@/components/shifts/windows-tab";

interface PricingDto {
  hourlyAgorot: number;
  package5Agorot: number;
  package10Agorot: number;
  package20Agorot: number;
  updatedAt: string;
  updatedByName: string | null;
}

/** שקלים שלמים או עם שתי ספרות אחרי הנקודה בלבד (אגורות) */
const PRICE = /^\d+(\.\d{1,2})?$/;

function toAgorot(value: string): number | null {
  if (!PRICE.test(value.trim())) return null;
  return Math.round(Number(value) * 100);
}

interface Row {
  key: "hourlyAgorot" | "package5Agorot" | "package10Agorot" | "package20Agorot";
  label: string;
  hint: string;
}

const ROWS: Row[] = [
  { key: "hourlyAgorot", label: "מחיר שעה בודדת", hint: "הזמנה חד-פעמית, ללא כרטיסייה" },
  { key: "package5Agorot", label: "כרטיסיית 5 שעות", hint: "תוקף שנה מיום הרכישה" },
  { key: "package10Agorot", label: "כרטיסיית 10 שעות", hint: "תוקף שנה מיום הרכישה" },
  { key: "package20Agorot", label: "כרטיסיית 20 שעות", hint: "תוקף שנה מיום הרכישה" },
];

/**
 * עריכת מחיר שעה בודדת וכרטיסיות השעות (5/10/20). שמירה מעדכנת את מקור האמת במסד ומשפיעה מיידית על
 * המחירון הציבורי, רכישות חדשות והזמנות חדשות. תשלומים וחבילות שכבר נרכשו שומרים את המחיר שנקבע להם בזמן
 * הרכישה ואינם משתנים. מחירי המשמרות החודשיות נערכים למטה, באותו מנגנון הקיים (יצירת משבצת חדשה והשבתת הישנה).
 */
export function PricingTab({ onChanged, tell }: { onChanged: () => void; tell: (tone: "success" | "error", text: string) => void }) {
  const [pricing, setPricing] = useState<PricingDto | null>(null);
  const [fields, setFields] = useState<Record<Row["key"], string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  const load = useCallback(async () => {
    const res = await api<{ pricing: PricingDto }>("/api/admin/finance/pricing");
    if (res.ok) {
      const p = (res.data as { pricing: PricingDto }).pricing;
      setPricing(p);
      setFields({
        hourlyAgorot: String(p.hourlyAgorot / 100),
        package5Agorot: String(p.package5Agorot / 100),
        package10Agorot: String(p.package10Agorot / 100),
        package20Agorot: String(p.package20Agorot / 100),
      });
    } else setError(res.data.error ?? "שגיאה בטעינת התמחור");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת התמחור מהשרת
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!pricing || !fields) return <Loading />;

  const parsed = Object.fromEntries(ROWS.map((r) => [r.key, fields[r.key] === "" ? null : toAgorot(fields[r.key])])) as Record<Row["key"], number | null>;
  const problem = ROWS.find((r) => parsed[r.key] === null || (parsed[r.key] as number) <= 0) ? "כל המחירים חייבים להיות מספר חיובי, בשקלים (עד שתי ספרות אחרי הנקודה)" : null;

  async function save() {
    await run(async () => {
      const res = await api<{ pricing: PricingDto }>("/api/admin/finance/pricing", { method: "PUT", body: parsed });
      if (res.ok) {
        const p = (res.data as { pricing: PricingDto }).pricing;
        setPricing(p);
        setFields({
          hourlyAgorot: String(p.hourlyAgorot / 100),
          package5Agorot: String(p.package5Agorot / 100),
          package10Agorot: String(p.package10Agorot / 100),
          package20Agorot: String(p.package20Agorot / 100),
        });
        tell("success", "המחירים נשמרו. השינוי חל מיידית על המחירון הציבורי ועל רכישות והזמנות חדשות.");
        onChanged();
      } else {
        tell("error", res.data.error ?? "לא ניתן לשמור");
      }
    });
  }

  return (
    <section className="space-y-8">
      <div className="space-y-4">
        <SectionTitle hint="מחיר שעה בודדת וכרטיסיות השעות. תשלומים וחבילות שכבר נרכשו אינם משתנים">מחיר שעה וכרטיסיות</SectionTitle>
        <p className="text-xs text-stone-500">
          עודכן לאחרונה: {fmtDateTime(pricing.updatedAt)}
          {pricing.updatedByName && <> על ידי {pricing.updatedByName}</>}
        </p>
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>פריט</th>
                <th>מחיר (₪)</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.label}
                    <span className="block text-xs text-stone-500">{r.hint}</span>
                  </td>
                  <td>
                    <input
                      aria-label={r.label}
                      type="number"
                      min={0.01}
                      step={0.01}
                      inputMode="decimal"
                      dir="ltr"
                      className="field"
                      value={fields[r.key]}
                      onChange={(e) => setFields({ ...fields, [r.key]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problem && <Alert tone="error">{problem}</Alert>}
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || problem !== null}>
          {busy ? "שומר..." : "שמירה"}
        </button>
      </div>

      <div className="border-t border-cream-200" />

      <WindowsTab onChanged={onChanged} tell={tell} />
    </section>
  );
}
