"use client";

type Tone = "ok" | "pending" | "bad" | "neutral";

const TONES: Record<Tone, string> = {
  ok: "bg-brand-50 text-brand-700 ring-1 ring-brand-100",
  pending: "bg-bronze-50 text-bronze-700 ring-1 ring-bronze-200",
  bad: "bg-red-50 text-red-700 ring-1 ring-red-100",
  neutral: "bg-cream-100 text-stone-600 ring-1 ring-cream-300",
};

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${TONES[tone]}`}>{children}</span>;
}

/** שעת ירושלים של רגע נתון, ללא תלות באזור הזמן של הדפדפן */
export const jerusalemTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });

export function Dialog({ title, labelId, onClose, children }: { title: string; labelId: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-stone-900/40 p-4" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelId} className="card w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 id={labelId} className="font-display text-xl font-bold text-stone-900">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
