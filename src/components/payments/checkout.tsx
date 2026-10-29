"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, BrandHeader, Icon, Loading, RoomTile, SectionTitle } from "@/components/ui";
import { InfoRow, PaymentStatusBadge, SandboxNotice, SandboxPanel } from "@/components/payments/bits";
import {
  api,
  dateText,
  durationText,
  formatCountdown,
  shekel,
  timeText,
  useHoldCountdown,
  usePaymentsGate,
  useSingleFlight,
} from "@/lib/payments/client";
import type { HoldDetails } from "@/lib/payments/views";
import type { RoomKey } from "@/generated/prisma/client";

type Notice = { tone: "error" | "success" | "warn"; text: string };

const POLL_MS = 4000;

/** הודעות לפי תוצאת האימות שהשרת החזיר. אף תוצאה אינה מוסתרת: כישלון, ביטול והחזר מוצגים במפורש */
function noticeForOutcome(outcome: string): Notice | null {
  switch (outcome) {
    case "CONFIRMED":
    case "ALREADY_CONFIRMED":
      return { tone: "success", text: "התשלום אומת והזמנה אושרה." };
    case "PAYMENT_FAILED":
      return { tone: "error", text: "התשלום נכשל, ולא בוצע חיוב. החדר עדיין שמור עבורכם בזמן שנותר: אפשר לנסות שוב." };
    case "PAYMENT_CANCELLED":
      return { tone: "warn", text: "התשלום בוטל, ולא בוצע חיוב. החדר עדיין שמור עבורכם בזמן שנותר." };
    case "LATE_REFUNDED":
      return {
        tone: "error",
        text: "התשלום התקבל רק אחרי שההחזקה פגה, ולכן ההזמנה לא אושרה והסכום ששולם הוחזר במלואו. יש להתחיל הזמנה חדשה.",
      };
    case "BALANCE_CHANGED_REFUNDED":
      return {
        tone: "error",
        text: "יתרת החבילה השתנתה בזמן התשלום, ולכן ההזמנה לא אושרה והסכום ששולם הוחזר במלואו. לא נוכו דקות. יש להתחיל הזמנה חדשה.",
      };
    case "LATE_REFUND_FAILED":
    case "BALANCE_CHANGED_REFUND_FAILED":
      return {
        tone: "error",
        text: "ההזמנה לא אושרה, וההחזר הכספי עדיין לא הושלם. ההחזר בטיפול. אם הוא לא מופיע בהיסטוריה בקרוב, צרו קשר.",
      };
    case "AMOUNT_MISMATCH":
      return { tone: "error", text: "סכום התשלום אינו תואם להזמנה, ולכן לא אושרה. אנא צרו קשר." };
    default:
      return null;
  }
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (notice.tone !== "warn") return <Alert tone={notice.tone}>{notice.text}</Alert>;
  return (
    <p role="status" className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm bg-bronze-50 text-bronze-700 border border-bronze-200">
      <Icon name="hourglass" className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{notice.text}</span>
    </p>
  );
}

export function Checkout({ appointmentId }: { appointmentId: string }) {
  const router = useRouter();
  const gate = usePaymentsGate();
  const [details, setDetails] = useState<HoldDetails | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const action = useSingleFlight();
  const checking = useRef(false);

  const load = useCallback(async () => {
    const res = await api<HoldDetails>(`/api/payments/holds/${appointmentId}`);
    if (res.status === 404) {
      setMissing(true);
      return null;
    }
    if (res.status === 401) {
      router.push(`/login?callbackUrl=${encodeURIComponent(`/booking/checkout/${appointmentId}`)}`);
      return null;
    }
    if (res.status === 422 && (res.data as { code?: string }).code === "PROFILE_INCOMPLETE") {
      router.push(`/complete-profile?next=${encodeURIComponent(`/booking/checkout/${appointmentId}`)}`);
      return null;
    }
    if (!res.ok) {
      setNotice({ tone: "error", text: res.data.error ?? "שגיאה בטעינת ההזמנה" });
      return null;
    }
    setDetails(res.data as HoldDetails);
    return res.data as HoldDetails;
  }, [appointmentId, router]);

  /** מבקש מהשרת לאמת את התשלום מול הספק. רק תשובת השרת קובעת אם ההזמנה אושרה */
  const verifyPayment = useCallback(
    async (paymentId: string) => {
      if (checking.current) return;
      checking.current = true;
      try {
        const res = await api<{ outcome?: string }>(`/api/payments/${paymentId}`);
        if (res.ok && res.data.outcome) {
          const n = noticeForOutcome(res.data.outcome);
          if (n) setNotice(n);
        } else if (!res.ok) {
          setNotice({ tone: "error", text: res.data.error ?? "לא ניתן לאמת את התשלום כעת" });
        }
        await load();
      } finally {
        checking.current = false;
      }
    },
    [load]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינה ראשונית (וגם אחרי רענון דף) של מצב ההזמנה מהשרת
    load();
  }, [load]);

  const pending = details?.payment?.status === "PENDING" ? details.payment : null;

  // בזמן שיש תשלום ממתין: אימות תקופתי מול השרת. אחרי פקיעת ההחזקה זה גם מה שמסדר החזר לתשלום שהתקבל באיחור
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => void verifyPayment(pending.id), POLL_MS);
    return () => window.clearInterval(id);
  }, [pending, verifyPayment]);

  const remainingMs = useHoldCountdown(details?.holdExpiresAt ?? null, details?.serverNow ?? null, () => {
    void load();
  });

  if (missing) {
    return (
      <div className="max-w-2xl mx-auto">
        <Alert tone="error">ההזמנה לא נמצאה.</Alert>
        <Link href="/booking" className="btn btn-primary mt-4">
          חזרה לקביעת תור
        </Link>
      </div>
    );
  }
  if (!details) {
    return <div className="max-w-2xl mx-auto">{notice ? <NoticeBox notice={notice} /> : <Loading />}</div>;
  }

  const when = `${new Date(details.startTime).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "numeric" })} · ${timeText(details.startTime)} – ${timeText(details.endTime)}`;

  async function pay(useBalance: boolean) {
    await action.run(async () => {
      setNotice(null);
      const res = await api(`/api/payments/holds/${appointmentId}/pay`, { body: { useBalance } });
      if (!res.ok) setNotice({ tone: "error", text: res.data.error ?? "לא ניתן לפתוח תשלום" });
      await load();
    });
  }

  async function confirmFromBalance() {
    await action.run(async () => {
      setNotice(null);
      const res = await api(`/api/payments/holds/${appointmentId}/confirm-balance`, { body: {} });
      if (res.ok) setNotice({ tone: "success", text: "ההזמנה אושרה מהיתרה." });
      else if (res.data.code === "INSUFFICIENT_BALANCE") {
        setNotice({ tone: "error", text: "היתרה השתנתה ואינה מספיקה להזמנה זו. לא נוכו דקות. אפשר לשלם בכסף." });
      } else setNotice({ tone: "error", text: res.data.error ?? "לא ניתן לאשר מהיתרה" });
      await load();
    });
  }

  async function releaseHold() {
    await action.run(async () => {
      const res = await api(`/api/payments/bookings/${appointmentId}/cancel`, { body: {} });
      if (res.ok) router.push("/booking");
      else setNotice({ tone: "error", text: res.data.error ?? "לא ניתן לבטל" });
    });
  }

  // ───── הזמנה אושרה (לפי השרת בלבד) ─────
  if (details.status === "CONFIRMED") {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <BrandHeader eyebrow="תשלום" title="ההזמנה אושרה" subtitle="תודה, החדר שלכם שמור" />
        {notice && <NoticeBox notice={notice} />}
        <section className="card p-5 sm:p-8 space-y-1" data-testid="confirmed">
          <div className="flex items-center gap-4 mb-3">
            <RoomTile roomKey={details.room.key as RoomKey} />
            <div>
              <p className="font-display text-lg font-bold text-stone-900">{details.room.name}</p>
              <p className="text-sm text-stone-500">{when}</p>
            </div>
          </div>
          {details.paidFromBalanceMinutes > 0 && <InfoRow label="שולם מהיתרה">{durationText(details.paidFromBalanceMinutes)}</InfoRow>}
          {details.paidCashAgorot > 0 && <InfoRow label="שולם בכסף">{shekel(details.paidCashAgorot)}</InfoRow>}
          <InfoRow label="תאריך">{dateText(details.startTime)}</InfoRow>
        </section>
        <div className="flex flex-wrap gap-3">
          <Link href="/booking/my" className="btn btn-primary">
            התורים שלי
          </Link>
          <Link href="/booking" className="btn btn-secondary">
            הזמנה נוספת
          </Link>
        </div>
      </div>
    );
  }

  // ───── הזמנה בוטלה / ההחזקה פגה ─────
  if (!details.holdActive) {
    const refunded = details.payment?.status === "SUCCEEDED" && details.payment.refundedAgorot > 0;
    const chargedNoRefund = details.payment?.status === "SUCCEEDED" && details.payment.refundedAgorot === 0;
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <BrandHeader eyebrow="תשלום" title="ההזמנה לא אושרה" subtitle="יש להתחיל הזמנה חדשה" />
        {notice && <NoticeBox notice={notice} />}
        {refunded ? (
          <Alert tone="error">
            ההזמנה לא אושרה, והסכום ששולם ({shekel(details.payment!.refundedAgorot)}) הוחזר במלואו. אם שולמו גם דקות מחבילה, הן לא נוכו.
            זה קורה כשההחזקה פגה לפני אימות התשלום, או כשיתרת החבילה השתנתה בזמן התשלום.
          </Alert>
        ) : chargedNoRefund ? (
          <Alert tone="error">
            ההזמנה לא אושרה, וההחזר הכספי עדיין לא הושלם. ההחזר בטיפול. אם הוא לא מופיע בהיסטוריה בקרוב, צרו קשר.
          </Alert>
        ) : details.status === "CANCELLED" ? (
          <Alert tone="error">ההזמנה בוטלה.</Alert>
        ) : (
          <Alert tone="error">ההחזקה פגה. החדר שוחרר ולא בוצע חיוב. אפשר להתחיל מחדש.</Alert>
        )}
        <Link href="/booking" className="btn btn-primary">
          התחלת הזמנה חדשה
          <Icon name="arrowLeft" className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  // ───── החזקה פעילה: בחירת תשלום / ממתין לתשלום ─────
  const plan = details.plan;
  const urgent = remainingMs !== null && remainingMs < 60_000;
  const lastAttempt = details.payment && details.payment.status !== "PENDING" && details.payment.status !== "SUCCEEDED" ? details.payment : null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <BrandHeader eyebrow="תשלום" title="השלמת הזמנה" subtitle="החדר שמור עבורכם עד להשלמת התשלום" />

      {gate.sandbox && <SandboxNotice />}

      <div
        className={`flex items-center justify-between gap-4 rounded-2xl px-5 py-4 ring-1 ${
          urgent ? "bg-red-50 ring-red-100 text-red-700" : "bg-brand-50 ring-brand-100 text-brand-800"
        }`}
        role="timer"
        aria-live="off"
        data-testid="countdown"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon name="hourglass" className="w-5 h-5" />
          החדר שמור עבורכם
        </span>
        <span className="font-display text-2xl font-bold tabular-nums" dir="ltr">
          {remainingMs === null ? "--:--" : formatCountdown(remainingMs)}
        </span>
      </div>
      <p className="text-xs text-stone-400 -mt-3">הספירה מוצגת לנוחותכם בלבד. פקיעת ההחזקה נקבעת בשרת.</p>

      {notice && <NoticeBox notice={notice} />}
      {lastAttempt && !notice && (
        <NoticeBox
          notice={
            lastAttempt.status === "FAILED"
              ? { tone: "error", text: "ניסיון התשלום הקודם נכשל ולא בוצע חיוב. אפשר לנסות שוב." }
              : { tone: "warn", text: "ניסיון התשלום הקודם בוטל ולא בוצע חיוב." }
          }
        />
      )}

      <section className="card p-5 sm:p-8">
        <SectionTitle>פרטי ההזמנה</SectionTitle>
        <div className="flex items-center gap-4 mb-3">
          <RoomTile roomKey={details.room.key as RoomKey} />
          <div>
            <p className="font-display text-lg font-bold text-stone-900">{details.room.name}</p>
            <p className="text-sm text-stone-500">{when}</p>
          </div>
        </div>
        <InfoRow label="משך">{durationText(details.durationMinutes)}</InfoRow>
        <InfoRow label="מחיר רגיל">{shekel(details.fullPriceAgorot)}</InfoRow>
        <InfoRow label="יתרת שעות זמינה">{details.availableBalanceMinutes > 0 ? durationText(details.availableBalanceMinutes) : "אין יתרה"}</InfoRow>
      </section>

      {pending ? (
        <section className="card p-5 sm:p-8 space-y-4" data-testid="pending-payment">
          <SectionTitle aside={<PaymentStatusBadge status="PENDING" />}>ממתין לאישור התשלום</SectionTitle>
          {pending.packageMinutes > 0 && <InfoRow label="יינוכה מהיתרה לאחר אישור התשלום">{durationText(pending.packageMinutes)}</InfoRow>}
          <InfoRow label="סכום לתשלום">{shekel(pending.amountAgorot)}</InfoRow>
          <p className="text-sm text-stone-500">
            ההזמנה תאושר רק לאחר שהשרת יאמת את התשלום מול הספק. ניתן לרענן את הדף בבטחה: המצב נשמר.
          </p>
          {gate.sandbox && pending.providerPaymentId && (
            <SandboxPanel providerPaymentId={pending.providerPaymentId} onDone={() => void verifyPayment(pending.id)} />
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void verifyPayment(pending.id)}>
            בדיקת סטטוס עכשיו
          </button>
        </section>
      ) : (
        <section className="card p-5 sm:p-8 space-y-4">
          <SectionTitle hint="הסכום והדקות מחושבים בשרת">אופן התשלום</SectionTitle>
          {plan?.fullyCoveredByBalance ? (
            <>
              <p className="text-sm text-stone-600">
                היתרה שלכם מכסה את ההזמנה במלואה: <strong>{durationText(plan.packageMinutes)}</strong> יינוכו מהחבילה ללא תשלום בכסף.
              </p>
              <button type="button" className="btn btn-primary w-full" disabled={action.busy} onClick={confirmFromBalance}>
                {action.busy ? "מאשר..." : `אישור מהיתרה · ${durationText(plan.packageMinutes)}`}
              </button>
              <button type="button" className="btn btn-secondary w-full" disabled={action.busy} onClick={() => pay(false)}>
                לשלם בכסף במקום: {shekel(details.fullPriceAgorot)}
              </button>
            </>
          ) : plan && plan.packageMinutes > 0 ? (
            <>
              <p className="text-sm text-stone-600">
                היתרה שלכם ({durationText(plan.packageMinutes)}) לא מכסה את כל ההזמנה. אפשר לשלם את ההפרש בכסף:
                <strong> {shekel(plan.cashAgorot)}</strong>. הדקות מהחבילה יינוכו רק אחרי שהתשלום יאומת.
              </p>
              <button type="button" className="btn btn-primary w-full" disabled={action.busy} onClick={() => pay(true)}>
                {action.busy ? "פותח תשלום..." : `תשלום משולב: ${shekel(plan.cashAgorot)} + ${durationText(plan.packageMinutes)} מהיתרה`}
              </button>
              <button type="button" className="btn btn-secondary w-full" disabled={action.busy} onClick={() => pay(false)}>
                לשלם הכול בכסף: {shekel(details.fullPriceAgorot)}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-stone-600">אין לכם יתרת שעות זמינה, ולכן ההזמנה משולמת במחיר הרגיל.</p>
              <button type="button" className="btn btn-primary w-full" disabled={action.busy} onClick={() => pay(true)}>
                {action.busy ? "פותח תשלום..." : `תשלום ${shekel(details.fullPriceAgorot)}`}
              </button>
              <Link href="/profile/hours" className="block text-center text-sm text-brand-700 hover:underline">
                רכישת חבילת שעות במחיר משתלם יותר
              </Link>
            </>
          )}
        </section>
      )}

      <button type="button" className="btn btn-ghost w-full" disabled={action.busy} onClick={releaseHold}>
        ביטול ושחרור החדר
      </button>
    </div>
  );
}
