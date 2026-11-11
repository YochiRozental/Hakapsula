import Link from "next/link";
import { BrandHeader, Icon, SectionTitle } from "@/components/ui";
import { formatAgorot, regularPriceAgorot } from "@/lib/payments/pricing";
import { getRegularPricing, hoursPackageOptions } from "@/lib/payments/pricing-db";
import { listShiftWindows } from "@/lib/shifts/windows-db";
import { hhmm } from "@/lib/shifts/windows";

export const dynamic = "force-dynamic";
export const metadata = { title: "מחירון | הקפסולה" };

const TRIAL_DISCOUNT_PERCENT = 25;

export default async function PricingPage() {
  const [shiftWindowsAll, pricing] = await Promise.all([listShiftWindows({ activeOnly: true }), getRegularPricing()]);
  const shiftWindows = shiftWindowsAll.filter((w) => w.active);
  const packages = hoursPackageOptions(pricing);
  const singleHourAgorot = regularPriceAgorot(60, pricing.hourlyAgorot);
  const trialAgorot = Math.round((singleHourAgorot * (100 - TRIAL_DISCOUNT_PERCENT)) / 100);

  return (
    <div className="max-w-5xl mx-auto">
      <BrandHeader
        eyebrow="מחירון"
        title="המחירים שלנו"
        subtitle="כל מסלולי התמחור של הקפסולה — משמרות קבועות, כרטיסיות שעות, הזמנה בודדת ושעת ניסיון במחיר השקה"
      >
        <Link href="/booking" className="btn btn-bronze">
          הזמנת קליניקה
          <Icon name="arrowLeft" className="w-4 h-4" />
        </Link>
      </BrandHeader>

      {/* משמרות קבועות */}
      <section className="mb-10">
        <SectionTitle index="1" hint="יום קבוע בחדר קבוע, פעם בשבוע — חיוב חודשי, התחייבות למינימום 3 חודשים">
          משמרות קבועות
        </SectionTitle>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>שעות המשמרת</th>
                  <th>מחיר לחודש</th>
                </tr>
              </thead>
              <tbody>
                {shiftWindows.map((w) => (
                  <tr key={w.id}>
                    <td className="tabular-nums" dir="ltr">
                      {hhmm(w.startMinutes)}–{hhmm(w.endMinutes)}
                    </td>
                    <td className="tabular-nums">
                      <strong>{w.monthlyPriceAgorot / 100} ₪</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* כרטיסיות שעות */}
      <section className="mb-10">
        <SectionTitle index="2" hint="יתרת שעות לניצול גמיש, ללא התחייבות למשמרת קבועה">
          כרטיסיות שעות
        </SectionTitle>
        <div className="grid sm:grid-cols-3 gap-4">
          {packages.map((p) => (
            <div key={p.hours} className="card card-hover p-6 text-center">
              <p className="font-display text-lg font-bold text-stone-900">{p.hours} שעות</p>
              <p className="font-display text-3xl font-bold text-brand-700 mt-2 tabular-nums">{p.priceAgorot / 100} ₪</p>
            </div>
          ))}
        </div>
      </section>

      {/* הזמנה בודדת */}
      <section className="mb-10">
        <SectionTitle index="3" hint="הזמנת שעה בודדת, ללא רכישת כרטיסייה או משמרת">
          הזמנה בודדת
        </SectionTitle>
        <div className="card p-6 flex items-center justify-between gap-4 max-w-md">
          <p className="font-display text-lg font-bold text-stone-900">שעה אחת</p>
          <p className="font-display text-2xl font-bold text-brand-700 tabular-nums">{singleHourAgorot / 100} ₪</p>
        </div>
      </section>

      {/* מבצע השקה */}
      <section>
        <SectionTitle index="4" hint="שעת ניסיון ראשונה במחיר מבצע">
          מבצע השקה — שעת ניסיון
        </SectionTitle>
        <div className="card p-6 sm:p-7 max-w-md ring-1 ring-bronze-200 relative overflow-hidden">
          <span aria-hidden="true" className="absolute top-0 inset-x-6 hairline-bronze" />
          <span className="badge bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 ring-1 ring-bronze-200">
            <Icon name="sparkle" className="w-3.5 h-3.5" />
            {TRIAL_DISCOUNT_PERCENT}% הנחה להתנסות הראשונה
          </span>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="text-stone-400 line-through text-lg tabular-nums">{formatAgorot(singleHourAgorot)} ₪</span>
            <span className="font-display text-4xl font-bold text-brand-700 tabular-nums">{formatAgorot(trialAgorot)} ₪</span>
          </div>
          <p className="text-sm text-stone-500 mt-2">לשעת ניסיון ראשונה בלבד</p>
        </div>
      </section>
    </div>
  );
}
