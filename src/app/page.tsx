import Link from "next/link";
import { Icon, LogoMark, type IconName } from "@/components/ui";

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: "door", title: "מגוון חדרים", text: "חדר 1, חדר 2, חדר הסדנאות, או חדר 1+2 המשולב." },
  { icon: "calendar", title: "קביעה בקלות", text: "בוחרים חדר, תאריך ושעה — והתור נקבע." },
  { icon: "calendarCheck", title: "התורים שלך במקום אחד", text: "צפייה בתורים הקרובים וביטול בלחיצה." },
];

export default function Home() {
  return (
    <div className="space-y-8">
      <section className="panel-brand rounded-[2rem]">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-60 -z-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(255,236,200,0.28), transparent 40%), radial-gradient(circle at 85% 90%, rgba(13,92,83,0.55), transparent 45%)",
          }}
        />
        <div className="relative grid md:grid-cols-2 gap-10 items-center px-6 py-12 sm:px-12 sm:py-16">
          <div>
            <div className="flex items-center gap-4 mb-8">
              <span className="rounded-full p-1 bg-linear-to-b from-white to-cream-200 shadow-lg ring-1 ring-bronze-300/40">
                <LogoMark className="w-16 h-16 sm:w-20 sm:h-20" />
              </span>
              <div>
                <p className="font-display text-3xl sm:text-4xl font-bold">הקפסולה</p>
                <p className="text-sm text-bronze-200 tracking-wide mt-1">הבית שלך לפגישות עסקיות</p>
              </div>
            </div>
            <h1 className="font-display text-4xl sm:text-6xl font-bold leading-[1.1] mb-6">
              מקום מקצועי
              <br />
              לפגישות שלך
            </h1>
            <p className="text-white/80 text-lg leading-relaxed mb-8 max-w-md">
              ברוכים הבאים למערכת קביעת התורים. קבעו תור בקלות לחדר 1, חדר 2, חדר הסדנאות, או לחדר 1+2
              המשולב. יש להתחבר או להירשם כדי לקבוע תור.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/booking" className="btn btn-bronze px-7! py-3! text-base!">
                קביעת תור
                <Icon name="arrowLeft" className="w-4 h-4" />
              </Link>
              <Link
                href="/register"
                className="btn px-7! py-3! text-base! border border-white/30 text-white hover:bg-white/10"
              >
                הרשמה
              </Link>
            </div>
          </div>

          <div className="hidden md:flex justify-center">
            <div className="relative w-72 h-72 lg:w-80 lg:h-80 rounded-full bg-white/5 border border-white/15 flex items-center justify-center backdrop-blur-sm">
              <div className="absolute inset-6 rounded-full border border-bronze-300/25" />
              <div className="absolute -inset-6 rounded-full border border-white/5" />
              <span className="rounded-full p-4 bg-linear-to-b from-white to-cream-200 shadow-2xl ring-1 ring-bronze-300/40">
                <LogoMark className="w-40 h-40 lg:w-44 lg:h-44" />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="grid sm:grid-cols-3 gap-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="card card-hover p-7">
            <span className="w-12 h-12 rounded-2xl bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-600 ring-1 ring-bronze-200 shadow-sm flex items-center justify-center mb-5">
              <Icon name={f.icon} className="w-6 h-6" />
            </span>
            <h2 className="font-display text-lg font-bold text-stone-900 mb-1.5">{f.title}</h2>
            <p className="text-sm text-stone-500 leading-relaxed">{f.text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
