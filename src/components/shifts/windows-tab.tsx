"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Loading, SectionTitle } from "@/components/ui";
import { api, useSingleFlight } from "@/lib/payments/client";
import { hhmm, setShiftWindowRegistry, validateWindowInputs, type ShiftWindowDef, type WindowInput } from "@/lib/shifts/windows";

/** שורה בעריכה: שעות כמחרוזת HH:MM ומחיר כמחרוזת, כדי שאפשר יהיה להקליד בחופשיות לפני האימות */
interface Row {
  key: string;
  id?: string;
  name: string;
  start: string;
  end: string;
  price: string;
  active: boolean;
}

const toMinutes = (value: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const fromDef = (w: ShiftWindowDef): Row => ({
  key: w.id,
  id: w.id,
  name: w.name,
  start: hhmm(w.startMinutes),
  end: hhmm(w.endMinutes),
  price: String(w.monthlyPriceAgorot / 100),
  active: w.active,
});

const toInput = (r: Row): WindowInput => ({
  id: r.id,
  name: r.name,
  startMinutes: toMinutes(r.start),
  endMinutes: toMinutes(r.end),
  monthlyPriceShekel: r.price.trim() === "" ? NaN : Number(r.price),
  active: r.active,
});

let newRowCounter = 0;

/** עריכת משבצות המשמרת: שעות ומחיר חודשי. משפיע על הזמנות חדשות בלבד; משמרות קיימות ממשיכות במחיר ובשעות שנקבעו להן */
export function WindowsTab({ onChanged, tell }: { onChanged: () => void; tell: (tone: "success" | "error", text: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  const load = useCallback(async () => {
    const res = await api<{ windows: ShiftWindowDef[] }>("/api/admin/shifts/windows");
    if (res.ok) setRows((res.data as { windows: ShiftWindowDef[] }).windows.map(fromDef));
    else setError(res.data.error ?? "שגיאה בטעינת המשבצות");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינת המשבצות מהשרת
    load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!rows) return <Loading />;

  const update = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows([...rows, { key: `new-${++newRowCounter}`, name: "", start: "07:00", end: "11:00", price: "", active: true }]);

  const inputs = rows.map(toInput);
  const problem = validateWindowInputs(inputs);

  async function save() {
    await run(async () => {
      const res = await api<{ windows: ShiftWindowDef[] }>("/api/admin/shifts/windows", { method: "PUT", body: { windows: inputs } });
      if (res.ok) {
        const windows = (res.data as { windows: ShiftWindowDef[] }).windows;
        setShiftWindowRegistry(windows);
        setRows(windows.map(fromDef));
        tell("success", "המשבצות והמחירים נשמרו. השינוי חל על הזמנות חדשות.");
        onChanged();
      } else {
        tell("error", res.data.error ?? "לא ניתן לשמור");
      }
    });
  }

  return (
    <section className="space-y-4" data-testid="windows-tab">
      <SectionTitle hint="מחיר חודשי קבוע לכל משבצת, כולל מע&quot;מ">משבצות ומחירים</SectionTitle>
      <p className="text-sm text-stone-600">
        שינוי שעות או מחיר חל על <strong>הזמנות חדשות ועל שינויים שיאושרו מכאן והלאה</strong>. משמרות קיימות, מופעים וחיובים שכבר נקבעו אינם משתנים.
        משבצת שאינה נחוצה אפשר להשבית (אין מחיקה, כי משמרות קיימות מצביעות עליה). המחיר הוא בשקלים שלמים.
      </p>
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>שם</th>
              <th>משעה</th>
              <th>עד שעה</th>
              <th>מחיר לחודש (₪)</th>
              <th>פעילה</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              return (
                <tr key={r.key}>
                  <td>
                    <input aria-label="שם משבצת" className="field" maxLength={40} value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="שעת התחלה" type="time" step={900} dir="ltr" className="field" value={r.start} onChange={(e) => update(r.key, { start: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="שעת סיום" type="time" step={900} dir="ltr" className="field" value={r.end} onChange={(e) => update(r.key, { end: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="מחיר לחודש" type="number" min={1} step={1} inputMode="numeric" dir="ltr" className="field" value={r.price} onChange={(e) => update(r.key, { price: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="משבצת פעילה" type="checkbox" className="w-5 h-5" checked={r.active} onChange={(e) => update(r.key, { active: e.target.checked })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {problem && <Alert tone="error">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary" onClick={addRow} disabled={busy}>
          הוספת משבצת
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || problem !== null}>
          {busy ? "שומר..." : "שמירה"}
        </button>
      </div>
    </section>
  );
}
