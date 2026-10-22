"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui";

const SIZE = 240;
const CENTER = SIZE / 2;
const OUTER_R = 94;
const INNER_R = 62;
const BUBBLE_R = 17;

type Mode = "hours" | "minutes";

type ClockTimePickerProps = {
  /** "HH:mm" */
  value: string;
  onChange: (value: string) => void;
  /** גבולות בדקות מחצות (כולל) */
  minMinutes?: number;
  maxMinutes?: number;
  /** קפיצות הדקות המותרות */
  stepMinutes?: number;
  id?: string;
  label?: string;
  /** הצגה קבועה בתוך הטופס (ללא חלון קופץ); כל שינוי מעדכן מיד את הערך */
  inline?: boolean;
  /** שעות התחלה (בדקות מחצות) שאינן זמינות: מוצגות מוחלשות ואינן ניתנות לבחירה */
  unavailable?: (minutes: number) => boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
const format = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

function parse(text: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

function polar(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  // עיגול: ל-sin/cos יש הבדלי דיוק זעירים בין השרת לדפדפן, שגורמים לאזהרת hydration
  const round = (n: number) => Math.round(n * 100) / 100;
  return { x: round(CENTER + radius * Math.sin(rad)), y: round(CENTER - radius * Math.cos(rad)) };
}

export function ClockTimePicker({
  value,
  onChange,
  minMinutes = 0,
  maxMinutes = 23 * 60 + 59,
  stepMinutes = 1,
  id,
  label = "בחירת שעה",
  inline = false,
  unavailable,
}: ClockTimePickerProps) {
  const [open, setOpen] = useState(false);
  const autoId = useId();
  const fieldId = id ?? autoId;

  if (inline) {
    return (
      <ClockDialog
        inline
        value={value}
        label={label}
        inputId={fieldId}
        minMinutes={minMinutes}
        maxMinutes={maxMinutes}
        stepMinutes={stepMinutes}
        unavailable={unavailable}
        onConfirm={onChange}
      />
    );
  }

  return (
    <>
      <button
        id={fieldId}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="field flex items-center justify-between gap-2 text-right cursor-pointer"
      >
        <span className="tabular-nums" dir="ltr">
          {value}
        </span>
        <Icon name="clock" className="w-4.5 h-4.5 text-bronze-500" />
      </button>
      {open &&
        createPortal(
          <ClockDialog
            value={value}
            label={label}
            minMinutes={minMinutes}
            maxMinutes={maxMinutes}
            stepMinutes={stepMinutes}
            unavailable={unavailable}
            onCancel={() => setOpen(false)}
            onConfirm={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function ClockDialog({
  value,
  label,
  minMinutes,
  maxMinutes,
  stepMinutes,
  unavailable,
  inline = false,
  inputId,
  onCancel,
  onConfirm,
}: {
  unavailable?: (minutes: number) => boolean;
  inline?: boolean;
  inputId?: string;
  value: string;
  label: string;
  minMinutes: number;
  maxMinutes: number;
  stepMinutes: number;
  onCancel?: () => void;
  onConfirm: (value: string) => void;
}) {
  const initial = parse(value) ?? { h: 0, m: 0 };
  const [stateH, setH] = useState(initial.h);
  const [stateM, setM] = useState(initial.m);
  // במצב קבוע הערך שייך להורה (מקור אמת יחיד); בחלון — טיוטה עד אישור
  const h = inline ? initial.h : stateH;
  const m = inline ? initial.m : stateM;
  const [mode, setMode] = useState<Mode>("hours");
  // מה שהמשתמש מקליד כרגע בשדה (עד שהוא תקין ומוחל); null = מציגים את הערך הנבחר
  const [typed, setTyped] = useState<Record<Mode, string | null>>({ hours: null, minutes: null });
  const fieldRefs = { hours: useRef<HTMLInputElement>(null), minutes: useRef<HTMLInputElement>(null) };
  const dragging = useRef(false);
  const dialRef = useRef<SVGSVGElement>(null);
  const titleId = useId();

  const isValid = (hh: number, mm: number) => {
    const t = hh * 60 + mm;
    return t >= minMinutes && t <= maxMinutes && t % stepMinutes === 0 && !unavailable?.(t);
  };
  const hourHasOption = (hh: number) => {
    for (let mm = 0; mm < 60; mm++) if (isValid(hh, mm)) return true;
    return false;
  };

  useEffect(() => {
    if (inline) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel?.();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [inline, onCancel]);

  function apply(hh: number, mm: number) {
    setTyped({ hours: null, minutes: null });
    if (inline) return onConfirm(format(hh, mm));
    setH(hh);
    setM(mm);
  }

  function selectHour(hh: number) {
    if (isValid(hh, m)) return apply(hh, m);
    for (let mm = 0; mm < 60; mm++) if (isValid(hh, mm)) return apply(hh, mm);
  }

  function selectMinute(mm: number) {
    if (isValid(h, mm)) apply(h, mm);
  }

  /** האם ערך שהוקלד בשדה תקין וזמין (טווח, קפיצות וזמינות — אותם כללים כמו בשעון) */
  function typedValid(key: Mode, raw: string): boolean {
    const n = Number(raw);
    if (raw === "" || n > (key === "hours" ? 23 : 59)) return false;
    return key === "hours" ? hourHasOption(n) : isValid(h, n);
  }

  /** מחיל ערך שהוקלד אם הוא תקין (אחרת השעה הנבחרת לא משתנה). מחזיר אם הוחל */
  function commitTyped(key: Mode, raw: string): boolean {
    if (!typedValid(key, raw)) return false;
    if (key === "hours") selectHour(Number(raw));
    else selectMinute(Number(raw));
    return true;
  }

  function handleTyping(key: Mode, input: string) {
    const raw = input.replace(/\D/g, "").slice(0, 2);
    setTyped((t) => ({ ...t, [key]: raw }));
    // הקלדה שלמה: שתי ספרות, או ספרה ראשונה שאי אפשר להשלים (שעה 3–9, דקות 6–9)
    const complete = raw.length === 2 || Number(raw) > (key === "hours" ? 2 : 5);
    if (complete && commitTyped(key, raw) && key === "hours") {
      setMode("minutes");
      fieldRefs.minutes.current?.focus();
    }
  }

  function finishTyping(key: Mode) {
    const raw = typed[key];
    if (raw) commitTyped(key, raw);
    setTyped((t) => ({ ...t, [key]: null }));
  }

  function pointFromEvent(e: React.PointerEvent) {
    const rect = dialRef.current!.getBoundingClientRect();
    const scale = SIZE / rect.width;
    const x = (e.clientX - rect.left) * scale - CENTER;
    const y = (e.clientY - rect.top) * scale - CENTER;
    const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    return { angle, dist: Math.hypot(x, y) };
  }

  function pick(e: React.PointerEvent) {
    const { angle, dist } = pointFromEvent(e);
    if (mode === "hours") {
      const idx = Math.round(angle / 30) % 12;
      const inner = dist < (INNER_R + OUTER_R) / 2;
      selectHour(inner ? (idx === 0 ? 0 : idx + 12) : idx === 0 ? 12 : idx);
    } else {
      const raw = Math.round(angle / 6) % 60;
      const snapped = Math.round(raw / stepMinutes) * stepMinutes;
      selectMinute(snapped % 60);
    }
  }

  const hourInner = h === 0 || h > 12;
  const hourTip = polar((h % 12) * 30, hourInner ? INNER_R : OUTER_R);
  const minuteTip = polar(m * 6, OUTER_R);
  const activeTip = mode === "hours" ? hourTip : minuteTip;

  // טבעת חיצונית: 1–12, טבעת פנימית: 00 ו-13–23
  const marks = Array.from({ length: 24 }, (_, n) => ({
    num: n,
    pos: polar((n % 12) * 30, n === 0 || n > 12 ? INNER_R : OUTER_R),
  }));

  const content = (
    <>
        <div className="flex items-center justify-center gap-1 mb-4" dir="ltr">
          {(["hours", "minutes"] as const).map((key, i) => {
            const raw = typed[key];
            const invalid = raw !== null && raw.length > 0 && !typedValid(key, raw);
            return (
              <span key={key} className="flex items-center gap-1">
                {i === 1 && <span className="font-display text-4xl font-bold text-stone-400">:</span>}
                <input
                  ref={fieldRefs[key]}
                  id={key === "hours" ? inputId : undefined}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={2}
                  aria-label={key === "hours" ? "שעות (00–23)" : "דקות (00–59)"}
                  aria-invalid={invalid}
                  value={raw ?? pad(key === "hours" ? h : m)}
                  onChange={(e) => handleTyping(key, e.target.value)}
                  onFocus={(e) => {
                    setMode(key);
                    e.currentTarget.select();
                  }}
                  onClick={(e) => e.currentTarget.select()}
                  onMouseUp={(e) => e.preventDefault()}
                  onBlur={() => finishTyping(key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                  className={`w-20 text-center font-display text-4xl font-bold tabular-nums rounded-2xl px-1 py-1 cursor-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    invalid
                      ? "text-red-600 ring-1 ring-red-300"
                      : mode === key
                        ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
                        : "text-stone-700 hover:bg-cream-100"
                  }`}
                />
              </span>
            );
          })}
        </div>

        <div className="rounded-2xl bg-cream-50 ring-1 ring-cream-200 p-3 mx-auto w-fit max-w-full" dir="ltr">
          <svg
            ref={dialRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block w-full max-w-72 aspect-square touch-none select-none cursor-pointer"
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              pick(e);
            }}
            onPointerMove={(e) => {
              if (dragging.current) pick(e);
            }}
            onPointerUp={() => {
              if (!dragging.current) return;
              dragging.current = false;
              if (mode === "hours") setMode("minutes");
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
          >
            <circle cx={CENTER} cy={CENTER} r={CENTER - 2} fill="#fff" stroke="var(--color-cream-300)" />
            <circle cx={CENTER} cy={CENTER} r={INNER_R + 20} fill="none" stroke="var(--color-cream-200)" strokeDasharray="2 4" />

            {/* מחוג לא פעיל */}
            <line
              x1={CENTER}
              y1={CENTER}
              x2={(mode === "hours" ? minuteTip : hourTip).x}
              y2={(mode === "hours" ? minuteTip : hourTip).y}
              stroke="var(--color-bronze-300)"
              strokeWidth={2}
              strokeLinecap="round"
            />
            {/* מחוג פעיל */}
            <line
              x1={CENTER}
              y1={CENTER}
              x2={activeTip.x}
              y2={activeTip.y}
              stroke="var(--color-brand-600)"
              strokeWidth={3}
              strokeLinecap="round"
            />
            <circle cx={activeTip.x} cy={activeTip.y} r={BUBBLE_R} fill="var(--color-brand-600)" />
            <circle cx={CENTER} cy={CENTER} r={4.5} fill="var(--color-brand-600)" />
            <circle cx={CENTER} cy={CENTER} r={1.8} fill="var(--color-bronze-300)" />

            {mode === "hours"
              ? marks.map(({ num, pos }) => {
                  const disabled = !hourHasOption(num);
                  const selected = num === h;
                  return (
                    <text
                      key={num}
                      x={pos.x}
                      y={pos.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="tabular-nums pointer-events-none"
                      fontSize={num === 0 || num > 12 ? 12 : 14}
                      fontWeight={selected ? 700 : 600}
                      fill={selected ? "#fff" : disabled ? "var(--color-stone-300)" : "var(--color-stone-700)"}
                    >
                      {pad(num)}
                    </text>
                  );
                })
              : Array.from({ length: 12 }, (_, i) => {
                  const mm = i * 5;
                  const pos = polar(mm * 6, OUTER_R);
                  const reachable = mm % stepMinutes === 0;
                  const disabled = !reachable || !isValid(h, mm);
                  const selected = mm === m;
                  return (
                    <text
                      key={mm}
                      x={pos.x}
                      y={pos.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="tabular-nums pointer-events-none"
                      fontSize={14}
                      fontWeight={selected ? 700 : 600}
                      fill={selected ? "#fff" : disabled ? "var(--color-stone-300)" : "var(--color-stone-700)"}
                    >
                      {pad(mm)}
                    </text>
                  );
                })}
          </svg>
        </div>
    </>
  );

  if (inline) return <div dir="rtl">{content}</div>;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-900/55 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        dir="rtl"
        className="card w-full max-w-sm max-h-full overflow-y-auto p-5 sm:p-6 shadow-deep!"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="font-display text-lg font-bold text-stone-900">
            {label}
          </h3>
          <button type="button" onClick={onCancel} aria-label="סגירה" className="btn btn-ghost btn-sm px-2!">
            <Icon name="x" className="w-4 h-4" />
          </button>
        </div>

        {content}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel} className="btn btn-secondary">
            ביטול
          </button>
          <button
            type="button"
            disabled={!isValid(h, m)}
            onClick={() => onConfirm(format(h, m))}
            className="btn btn-primary px-6!"
          >
            אישור
          </button>
        </div>
      </div>
    </div>
  );
}
