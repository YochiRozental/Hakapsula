import type { ReactNode, SVGProps } from "react";
import type { RoomKey } from "@/generated/prisma/client";

/* ---------- אייקונים (קו נקי, 24x24) ---------- */

const ICON_PATHS = {
  home: "M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",
  calendar: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  calendarCheck: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 14l2 2 4-4",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  users: "M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3.5 3.5 0 0 1 0 6.7",
  user: "M19 20v-1.5A3.5 3.5 0 0 0 15.5 15h-7A3.5 3.5 0 0 0 5 18.5V20M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  door: "M5 21h14M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M13.5 12h.01",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  logout: "M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 16l-4-4 4-4M6 12h10",
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  arrowLeft: "M19 12H5M11 18l-6-6 6-6",
  chevronLeft: "m15 18-6-6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  menu: "M4 7h16M4 12h16M4 17h16",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
  hourglass: "M7 3h10M7 21h10M8 3v3a4 4 0 0 0 8 0V3M8 21v-3a4 4 0 0 1 8 0v3",
  ban: "M5.6 5.6l12.8 12.8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  phone: "M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z",
  mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM3 7l9 6 9-6",
  pin: "M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11ZM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  filter: "M4 5h16l-6 8v6l-4-2v-5L4 5Z",
  card: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM3 10h18M7 15h4",
};

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className = "w-5 h-5", ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/* ---------- לוגו הקפסולה ---------- */

export function LogoMark({ className = "w-11 h-11" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="kapsula-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f1ec" />
          <stop offset="35%" stopColor="#9b9792" />
          <stop offset="60%" stopColor="#5d5a56" />
          <stop offset="100%" stopColor="#c9c5bf" />
        </linearGradient>
        <linearGradient id="kapsula-k" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a4744" />
          <stop offset="100%" stopColor="#1f1d1b" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill="none" stroke="url(#kapsula-metal)" strokeWidth="3" />
      <circle cx="32" cy="32" r="25.5" fill="none" stroke="url(#kapsula-metal)" strokeWidth="0.8" opacity="0.6" />
      <text
        x="32"
        y="44"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontSize="36"
        fill="url(#kapsula-k)"
      >
        K
      </text>
    </svg>
  );
}

export function Logo({ tone = "dark", size = "md" }: { tone?: "dark" | "light"; size?: "md" | "lg" }) {
  const big = size === "lg";
  return (
    <span className="inline-flex items-center gap-3">
      <span
        className={`rounded-full p-0.5 bg-linear-to-b from-white to-cream-200 shadow-sm ring-1 ${
          tone === "light" ? "ring-white/30" : "ring-cream-300/70"
        }`}
      >
        <LogoMark className={big ? "w-20 h-20" : "w-11 h-11"} />
      </span>
      <span className="flex flex-col leading-none">
        <span
          className={`font-display font-bold ${big ? "text-4xl" : "text-[1.6rem]"} ${
            tone === "light" ? "text-white" : "text-stone-900"
          }`}
        >
          הקפסולה
        </span>
        <span
          className={`mt-1 tracking-wide ${big ? "text-sm" : "text-[10.5px]"} ${
            tone === "light" ? "text-bronze-200" : "text-bronze-600"
          }`}
        >
          הבית שלך לפגישות עסקיות
        </span>
      </span>
    </span>
  );
}

/* ---------- פריסה ותוכן ---------- */

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-stone-900 leading-tight">{title}</h1>
          {subtitle && <p className="text-sm sm:text-base text-stone-500 mt-2">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="hairline-bronze mt-6" />
    </div>
  );
}

/** כותרת ממותגת כהה לראש מסך — כולל סמל הלוגו */
export function BrandHeader({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel-brand rounded-[1.75rem] px-6 py-8 sm:px-10 sm:py-10 mb-8">
      <div
        aria-hidden="true"
        className="absolute -left-16 -top-16 w-72 h-72 rounded-full border border-white/10 -z-10"
      />
      <div
        aria-hidden="true"
        className="absolute -left-4 -top-4 w-48 h-48 rounded-full border border-bronze-300/20 -z-10"
      />
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          <span className="hidden sm:block rounded-full p-1 bg-linear-to-b from-white to-cream-200 shadow-lg ring-1 ring-bronze-300/40">
            <LogoMark className="w-16 h-16" />
          </span>
          <div>
            {eyebrow && <p className="text-xs font-bold tracking-[0.12em] text-bronze-300 mb-2">{eyebrow}</p>}
            <h1 className="font-display text-3xl sm:text-4xl font-bold leading-tight">{title}</h1>
            {subtitle && <p className="text-white/70 mt-2 text-sm sm:text-base">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SectionTitle({
  index,
  children,
  aside,
  hint,
}: {
  index?: string;
  children: ReactNode;
  aside?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="flex items-center gap-3">
        {index && (
          <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold tabular-nums text-bronze-700 bg-linear-to-b from-bronze-50 to-bronze-100 ring-1 ring-bronze-200 shadow-sm">
            {index}
          </span>
        )}
        <div>
          <h2 className="font-display text-lg font-bold text-stone-900 leading-tight">{children}</h2>
          {hint && <p className="text-xs text-stone-400 mt-0.5">{hint}</p>}
        </div>
      </div>
      {aside}
    </div>
  );
}

const STAT_TONES = {
  brand: "bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-brand-100",
  gold: "bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-600 ring-bronze-200",
  blue: "bg-linear-to-b from-sky-50 to-sky-100 text-sky-700 ring-sky-100",
  stone: "bg-linear-to-b from-cream-50 to-cream-200 text-stone-600 ring-cream-300",
};

export function StatCard({
  label,
  value,
  icon,
  tone = "brand",
}: {
  label: string;
  value: ReactNode;
  icon: IconName;
  tone?: keyof typeof STAT_TONES;
}) {
  return (
    <div className="card card-hover relative overflow-hidden p-5 sm:p-6 flex items-center justify-between gap-3">
      <span aria-hidden="true" className="absolute top-0 inset-x-6 hairline-bronze" />
      <div>
        <p className="font-display text-3xl sm:text-4xl font-bold text-stone-900 tabular-nums">{value}</p>
        <p className="text-sm text-stone-500 mt-1.5">{label}</p>
      </div>
      <span className={`w-12 h-12 rounded-2xl ring-1 flex items-center justify-center shrink-0 ${STAT_TONES[tone]}`}>
        <Icon name={icon} className="w-6 h-6" />
      </span>
    </div>
  );
}

export function Alert({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${
        tone === "error"
          ? "bg-red-50 text-red-700 border border-red-100"
          : "bg-brand-50 text-brand-700 border border-brand-100"
      }`}
    >
      <Icon name={tone === "error" ? "x" : "check"} className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function EmptyState({ icon = "calendar", children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="rounded-[1.25rem] border border-dashed border-bronze-200 bg-bronze-50/50 px-6 py-12 flex flex-col items-center text-center gap-3">
      <span className="w-14 h-14 rounded-full bg-white text-bronze-500 ring-1 ring-bronze-200 shadow-sm flex items-center justify-center">
        <Icon name={icon} className="w-6 h-6" />
      </span>
      <p className="text-sm text-stone-500">{children}</p>
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-stone-500 py-6" role="status">
      <span className="w-4 h-4 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin" />
      טוען...
    </div>
  );
}

/* ---------- צבעי חדרים ---------- */

export const ROOM_ACCENTS: Record<RoomKey, { tile: string; block: string; text: string; dot: string; visual: string }> = {
  ROOM1: {
    tile: "bg-linear-to-b from-brand-50 to-brand-100 text-brand-600 ring-brand-100",
    block: "bg-brand-50 border-brand-200 text-brand-800",
    text: "text-brand-700",
    dot: "bg-brand-600",
    visual: "from-brand-100 via-cream-50 to-brand-50",
  },
  ROOM2: {
    tile: "bg-linear-to-b from-sky-50 to-sky-100 text-sky-700 ring-sky-100",
    block: "bg-sky-50 border-sky-200 text-sky-900",
    text: "text-sky-700",
    dot: "bg-sky-600",
    visual: "from-sky-100 via-cream-50 to-sky-50",
  },
  ROOM3: {
    tile: "bg-linear-to-b from-rose-50 to-rose-100 text-rose-700 ring-rose-100",
    block: "bg-rose-50 border-rose-200 text-rose-900",
    text: "text-rose-700",
    dot: "bg-rose-500",
    visual: "from-rose-100 via-cream-50 to-rose-50",
  },
  ROOM4: {
    tile: "bg-linear-to-b from-violet-50 to-violet-100 text-violet-700 ring-violet-100",
    block: "bg-violet-50 border-violet-200 text-violet-900",
    text: "text-violet-700",
    dot: "bg-violet-500",
    visual: "from-violet-100 via-cream-50 to-violet-50",
  },
  WORKSHOP: {
    tile: "bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-600 ring-bronze-200",
    block: "bg-bronze-50 border-bronze-200 text-bronze-700",
    text: "text-bronze-600",
    dot: "bg-bronze-500",
    visual: "from-bronze-100 via-cream-50 to-bronze-50",
  },
  ROOM1_2: {
    tile: "bg-linear-to-b from-cream-50 to-cream-200 text-stone-600 ring-cream-300",
    block: "bg-cream-100 border-cream-300 text-stone-700",
    text: "text-stone-600",
    dot: "bg-stone-500",
    visual: "from-cream-200 via-cream-50 to-cream-100",
  },
};

const ROOM_ICONS: Record<RoomKey, IconName> = {
  ROOM1: "door",
  ROOM2: "door",
  ROOM3: "door",
  ROOM4: "door",
  WORKSHOP: "users",
  ROOM1_2: "grid",
};

export function RoomTile({ roomKey, className = "w-14 h-14" }: { roomKey: RoomKey; className?: string }) {
  return (
    <span
      className={`rounded-2xl ring-1 shadow-sm flex items-center justify-center shrink-0 ${ROOM_ACCENTS[roomKey].tile} ${className}`}
    >
      <Icon name={ROOM_ICONS[roomKey]} className="w-6 h-6" />
    </span>
  );
}

/**
 * אזור תצוגה לחדר — שמור לתמונה מקורית של החדר בעתיד.
 * כרגע מוצג רקע ארכיטקטוני עדין עם אייקון החדר.
 */
export function RoomVisual({ roomKey, className = "" }: { roomKey: RoomKey; className?: string }) {
  return (
    <div
      className={`relative overflow-hidden bg-linear-to-br ${ROOM_ACCENTS[roomKey].visual} ${className}`}
      aria-hidden="true"
    >
      <div className="absolute inset-x-[22%] bottom-0 top-[22%] rounded-t-full border border-white/80 border-b-0" />
      <div className="absolute inset-x-[34%] bottom-0 top-[40%] rounded-t-full border border-white/60 border-b-0" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-white/70 to-transparent" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className={`w-12 h-12 rounded-full bg-white/85 backdrop-blur-sm shadow-sm flex items-center justify-center ${ROOM_ACCENTS[roomKey].text}`}>
          <Icon name={ROOM_ICONS[roomKey]} className="w-6 h-6" />
        </span>
      </span>
    </div>
  );
}

/* ---------- מסגרת למסכי התחברות והרשמה ---------- */

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto card overflow-hidden grid md:grid-cols-[1fr_1.15fr] shadow-deep!">
      <div className="panel-brand hidden md:flex flex-col justify-between p-10 lg:p-12 min-h-[520px]">
        <div aria-hidden="true" className="absolute -left-24 -bottom-24 w-96 h-96 rounded-full border border-white/10 -z-10" />
        <div aria-hidden="true" className="absolute -left-8 -bottom-8 w-64 h-64 rounded-full border border-bronze-300/25 -z-10" />
        <span className="rounded-full p-1 w-fit bg-linear-to-b from-white to-cream-200 shadow-lg ring-1 ring-bronze-300/40">
          <LogoMark className="w-20 h-20" />
        </span>
        <div>
          <p className="text-xs font-bold tracking-[0.14em] text-bronze-300 mb-3">ברוכים הבאים</p>
          <p className="font-display text-4xl font-bold leading-tight">הקפסולה</p>
          <p className="text-white/75 mt-3 leading-relaxed max-w-xs">
            הבית שלך לפגישות עסקיות — חדרי קליניקה מוקפדים, זמינים בכמה לחיצות.
          </p>
          <div className="hairline-bronze mt-8 max-w-48" />
        </div>
      </div>
      <div className="p-6 sm:p-10 lg:p-12 flex flex-col justify-center">
        <div className="md:hidden mb-8">
          <Logo />
        </div>
        <h1 className="font-display text-3xl font-bold text-stone-900">{title}</h1>
        <p className="text-sm text-stone-500 mt-2 mb-8">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}
