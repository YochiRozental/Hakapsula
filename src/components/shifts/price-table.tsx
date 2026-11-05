import { hhmm, type ShiftWindowDef } from "@/lib/shifts/windows";

/** מחירון משמרות קבועות: חלון שעות, תדירות, מחיר חודשי כולל מע"מ והתחייבות מינימלית. מוצג ללקוח לפי המשבצות הפעילות */
export function ShiftPriceTable({ windows }: { windows: ShiftWindowDef[] }) {
  const active = windows.filter((w) => w.active);
  if (active.length === 0) return null;
  return (
    <div className="card overflow-hidden" data-testid="shift-price-table">
      <h3 className="font-display text-lg font-bold text-stone-900 px-5 pt-5">מחירון כולל מע&quot;מ עבור חדר קבוע בשעות קבועות</h3>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>שעות המשמרת</th>
              <th>תדירות</th>
              <th>מחיר לחודש</th>
              <th>סה&quot;כ לשלושה חודשים</th>
              <th>תקופה</th>
            </tr>
          </thead>
          <tbody>
            {active.map((w) => (
              <tr key={w.id}>
                <td className="tabular-nums">
                  {hhmm(w.startMinutes)} עד {hhmm(w.endMinutes)}
                </td>
                <td>
                  יום קבוע
                  <br />
                  בחדר קבוע
                  <br />
                  פעם בשבוע
                </td>
                <td className="tabular-nums">
                  <strong>{w.monthlyPriceAgorot / 100} ₪</strong>
                </td>
                <td className="tabular-nums">{(w.monthlyPriceAgorot * 3) / 100} ₪</td>
                <td>3 חודשים מלאים</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
