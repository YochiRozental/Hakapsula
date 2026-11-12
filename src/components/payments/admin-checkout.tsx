"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Icon, Loading, RoomTile, SectionTitle } from "@/components/ui";
import {
  InfoRow,
  PaymentStatusBadge,
  SandboxNotice,
  SandboxPanel,
  TrialDiscountRow,
} from "@/components/payments/bits";
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

/** גרסה מצומצמת של noticeForOutcome מ-Checkout (checkout.tsx): אותן תוצאות, אותם ניסוחים */
function noticeForOutcome(outcome: string): Notice | null {
  switch (outcome) {
    case "CONFIRMED":
    case "ALREADY_CONFIRMED":
      return { tone: "success", text: "התשלום אומת והתור אושר." };
    case "PAYMENT_FAILED":
      return {
        tone: "error",
        text: "התשלום נכשל, ולא בוצע חיוב. החדר עדיין שמור בזמן שנותר: אפשר לנסות שוב.",
      };
    case "PAYMENT_CANCELLED":
      return {
        tone: "warn",
        text: "התשלום בוטל, ולא בוצע חיוב. החדר עדיין שמור בזמן שנותר.",
      };
    case "LATE_REFUNDED":
      return {
        tone: "error",
        text: "התשלום התקבל רק אחרי שההחזקה פגה, ולכן התור לא אושר והסכום הוחזר במלואו. יש להתחיל מחדש.",
      };
    case "BALANCE_CHANGED_REFUNDED":
      return {
        tone: "error",
        text: "יתרת החבילה של הלקוח השתנתה בזמן התשלום, ולכן התור לא אושר והסכום הוחזר במלואו. יש להתחיל מחדש.",
      };
    case "LATE_REFUND_FAILED":
    case "BALANCE_CHANGED_REFUND_FAILED":
      return {
        tone: "error",
        text: "התור לא אושר, וההחזר הכספי עדיין בטיפול.",
      };
    case "AMOUNT_MISMATCH":
      return {
        tone: "error",
        text: "סכום התשלום אינו תואם להזמנה, ולכן לא אושרה.",
      };
    default:
      return null;
  }
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (notice.tone !== "warn")
    return <Alert tone={notice.tone}>{notice.text}</Alert>;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm bg-bronze-50 text-bronze-700 border border-bronze-200"
    >
      <Icon name="hourglass" className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{notice.text}</span>
    </p>
  );
}

/**
 * השלמת תשלום להחזקה שמנהל יצר עבור לקוח, בתוך עמוד "הזמנת קליניקה ידנית" — גרסת מנהל של Checkout
 * (components/payments/checkout.tsx): אותה לוגיקת ספירה/polling/תוצאות, נתיבי יצירה/תשלום/יתרה ייעודיים
 * למנהל (/api/admin/payments/holds/...), ואימות תשלום/ביטול דרך הנתיבים הקיימים שכבר תומכים במנהל.
 */
export function AdminCheckout({
  appointmentId,
  customerName,
  onConfirmed,
  onCancelled,
}: {
  appointmentId: string;
  customerName: string;
  /** נקרא פעם אחת ברגע שהתור מאושר בפועל (לפי תשובת השרת בלבד) */
  onConfirmed: () => void;
  /** נקרא אחרי שההחזקה שוחררה/בוטלה בהצלחה */
  onCancelled: () => void;
}) {
  const gate = usePaymentsGate();
  const [details, setDetails] = useState<HoldDetails | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const action = useSingleFlight();
  const checking = useRef(false);
  const confirmedRef = useRef(false);

  const load = useCallback(async () => {
    const res = await api<HoldDetails>(
      `/api/admin/payments/holds/${appointmentId}`,
    );
    if (res.status === 404) {
      setMissing(true);
      return null;
    }
    if (!res.ok) {
      setNotice({
        tone: "error",
        text: res.data.error ?? "שגיאה בטעינת ההזמנה",
      });
      return null;
    }
    const data = res.data as HoldDetails;
    setDetails(data);
    if (data.status === "CONFIRMED" && !confirmedRef.current) {
      confirmedRef.current = true;
      onConfirmed();
    }
    return data;
  }, [appointmentId, onConfirmed]);

  const verifyPayment = useCallback(
    async (paymentId: string) => {
      if (checking.current) return;
      checking.current = true;
      try {
        const res = await api<{ outcome?: string }>(
          `/api/payments/${paymentId}`,
        );
        if (res.ok && res.data.outcome) {
          const n = noticeForOutcome(res.data.outcome);
          if (n) setNotice(n);
        } else if (!res.ok) {
          setNotice({
            tone: "error",
            text: res.data.error ?? "לא ניתן לאמת את התשלום כעת",
          });
        }
        await load();
      } finally {
        checking.current = false;
      }
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- טעינה ראשונית של מצב ההחזקה מהשרת
    load();
  }, [load]);

  const pending =
    details?.payment?.status === "PENDING" ? details.payment : null;

  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(
      () => void verifyPayment(pending.id),
      POLL_MS,
    );
    return () => window.clearInterval(id);
  }, [pending, verifyPayment]);

  const remainingMs = useHoldCountdown(
    details?.holdExpiresAt ?? null,
    details?.serverNow ?? null,
    () => {
      void load();
    },
  );

  if (missing) {
    return <Alert tone="error">ההזמנה לא נמצאה.</Alert>;
  }
  if (!details) {
    return (
      <div className="py-4">
        {notice ? <NoticeBox notice={notice} /> : <Loading />}
      </div>
    );
  }

  const when = `${dateText(details.startTime)} · ${timeText(details.startTime)} – ${timeText(details.endTime)}`;

  async function pay(useBalance: boolean) {
    await action.run(async () => {
      setNotice(null);
      const res = await api(`/api/admin/payments/holds/${appointmentId}/pay`, {
        body: { useBalance },
      });
      if (!res.ok)
        setNotice({
          tone: "error",
          text: res.data.error ?? "לא ניתן לפתוח תשלום",
        });
      await load();
    });
  }

  async function confirmFromBalance() {
    await action.run(async () => {
      setNotice(null);
      const res = await api(
        `/api/admin/payments/holds/${appointmentId}/confirm-balance`,
        { body: {} },
      );
      if (res.ok) setNotice({ tone: "success", text: "התור אושר מהיתרה." });
      else if (res.data.code === "INSUFFICIENT_BALANCE") {
        setNotice({
          tone: "error",
          text: "היתרה השתנתה ואינה מספיקה. לא נוכו דקות. אפשר לשלם בכסף.",
        });
      } else
        setNotice({
          tone: "error",
          text: res.data.error ?? "לא ניתן לאשר מהיתרה",
        });
      await load();
    });
  }

  async function releaseHold() {
    await action.run(async () => {
      const res = await api(`/api/payments/bookings/${appointmentId}/cancel`, {
        body: {},
      });
      if (res.ok) onCancelled();
      else setNotice({ tone: "error", text: res.data.error ?? "לא ניתן לבטל" });
    });
  }

  if (details.status === "CONFIRMED") {
    return (
      <div className="space-y-4" data-testid="admin-confirmed">
        {notice && <NoticeBox notice={notice} />}
        <section className="card p-5 space-y-1">
          <div className="flex items-center gap-4 mb-3">
            <RoomTile roomKey={details.room.key as RoomKey} />
            <div>
              <p className="font-display text-lg font-bold text-stone-900">
                {details.room.name}
              </p>
              <p className="text-sm text-stone-500">{when}</p>
            </div>
          </div>
          {details.paidFromBalanceMinutes > 0 && (
            <InfoRow label="שולם מהיתרה">
              {durationText(details.paidFromBalanceMinutes)}
            </InfoRow>
          )}
          {details.paidCashAgorot > 0 && (
            <InfoRow label="שולם בכסף">
              {shekel(details.paidCashAgorot)}
            </InfoRow>
          )}
          {details.payment && details.payment.discountAgorot > 0 && (
            <TrialDiscountRow discountAgorot={details.payment.discountAgorot} shekel={shekel} />
          )}
        </section>
      </div>
    );
  }

  if (!details.holdActive) {
    const refunded =
      details.payment?.status === "SUCCEEDED" &&
      details.payment.refundedAgorot > 0;
    const chargedNoRefund =
      details.payment?.status === "SUCCEEDED" &&
      details.payment.refundedAgorot === 0;
    return (
      <div className="space-y-4">
        {notice && <NoticeBox notice={notice} />}
        {refunded ? (
          <Alert tone="error">
            התור לא אושר, והסכום ששולם (
            {shekel(details.payment!.refundedAgorot)}) הוחזר במלואו.
          </Alert>
        ) : chargedNoRefund ? (
          <Alert tone="error">התור לא אושר, וההחזר הכספי עדיין בטיפול.</Alert>
        ) : details.status === "CANCELLED" ? (
          <Alert tone="error">ההזמנה בוטלה.</Alert>
        ) : (
          <Alert tone="error">ההחזקה פגה. החדר שוחרר ולא בוצע חיוב.</Alert>
        )}
      </div>
    );
  }

  const plan = details.plan;
  const urgent = remainingMs !== null && remainingMs < 60_000;
  const lastAttempt =
    details.payment &&
    details.payment.status !== "PENDING" &&
    details.payment.status !== "SUCCEEDED"
      ? details.payment
      : null;

  return (
    <div className="space-y-4">
      <SectionTitle hint={`עבור ${customerName}`}>
        תשלום להשלמת התור
      </SectionTitle>

      {gate.sandbox && <SandboxNotice />}

      <div
        className={`flex items-center justify-between gap-4 rounded-2xl px-5 py-4 ring-1 ${
          urgent
            ? "bg-red-50 ring-red-100 text-red-700"
            : "bg-brand-50 ring-brand-100 text-brand-800"
        }`}
        role="timer"
        aria-live="off"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon name="hourglass" className="w-5 h-5" />
          החדר שמור
        </span>
        <span
          className="font-display text-2xl font-bold tabular-nums"
          dir="ltr"
        >
          {remainingMs === null ? "--:--" : formatCountdown(remainingMs)}
        </span>
      </div>

      {notice && <NoticeBox notice={notice} />}
      {lastAttempt && !notice && (
        <NoticeBox
          notice={
            lastAttempt.status === "FAILED"
              ? {
                  tone: "error",
                  text: "ניסיון התשלום הקודם נכשל ולא בוצע חיוב. אפשר לנסות שוב.",
                }
              : {
                  tone: "warn",
                  text: "ניסיון התשלום הקודם בוטל ולא בוצע חיוב.",
                }
          }
        />
      )}

      <section className="card p-5 space-y-1">
        <div className="flex items-center gap-4 mb-3">
          <RoomTile roomKey={details.room.key as RoomKey} />
          <div>
            <p className="font-display text-lg font-bold text-stone-900">
              {details.room.name}
            </p>
            <p className="text-sm text-stone-500">{when}</p>
          </div>
        </div>
        <InfoRow label="משך">{durationText(details.durationMinutes)}</InfoRow>
        <InfoRow label="מחיר רגיל">{shekel(details.fullPriceAgorot)}</InfoRow>
        {plan && <TrialDiscountRow discountAgorot={plan.discountAgorot} shekel={shekel} />}
        <InfoRow label="יתרת שעות זמינה ללקוח">
          {details.availableBalanceMinutes > 0
            ? durationText(details.availableBalanceMinutes)
            : "אין יתרה"}
        </InfoRow>
      </section>

      {pending ? (
        <section className="card p-5 space-y-4">
          <SectionTitle aside={<PaymentStatusBadge status="PENDING" />}>
            ממתין לאישור התשלום
          </SectionTitle>
          {pending.packageMinutes > 0 && (
            <InfoRow label="יינוכה מהיתרה לאחר אישור">
              {durationText(pending.packageMinutes)}
            </InfoRow>
          )}
          <TrialDiscountRow discountAgorot={pending.discountAgorot} shekel={shekel} />
          <InfoRow label="סכום לתשלום">{shekel(pending.amountAgorot)}</InfoRow>
          {gate.sandbox && pending.providerPaymentId && (
            <SandboxPanel
              providerPaymentId={pending.providerPaymentId}
              onDone={() => void verifyPayment(pending.id)}
            />
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void verifyPayment(pending.id)}
          >
            בדיקת סטטוס עכשיו
          </button>
        </section>
      ) : (
        <section className="card p-5 space-y-4">
          <SectionTitle hint="הסכום והדקות מחושבים בשרת">
            אופן התשלום
          </SectionTitle>
          {plan?.fullyCoveredByBalance ? (
            <>
              <p className="text-sm text-stone-600">
                היתרה של הלקוח מכסה את התור במלואו:{" "}
                <strong>{durationText(plan.packageMinutes)}</strong> יינוכו
                מהחבילה ללא תשלום בכסף.
              </p>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={action.busy}
                onClick={confirmFromBalance}
              >
                {action.busy
                  ? "מאשר..."
                  : `אישור מהיתרה · ${durationText(plan.packageMinutes)}`}
              </button>
              <button
                type="button"
                className="btn btn-secondary w-full"
                disabled={action.busy}
                onClick={() => pay(false)}
              >
                לשלם בכסף במקום: {shekel(details.cashOnlyPlan?.cashAgorot ?? details.fullPriceAgorot)}
              </button>
            </>
          ) : plan && plan.packageMinutes > 0 ? (
            <>
              <p className="text-sm text-stone-600">
                היתרה של הלקוח ({durationText(plan.packageMinutes)}) לא מכסה את
                כל התור. ההפרש: <strong>{shekel(plan.cashAgorot)}</strong>.
              </p>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={action.busy}
                onClick={() => pay(true)}
              >
                {action.busy
                  ? "פותח תשלום..."
                  : `תשלום משולב: ${shekel(plan.cashAgorot)} + ${durationText(plan.packageMinutes)} מהיתרה`}
              </button>
              <button
                type="button"
                className="btn btn-secondary w-full"
                disabled={action.busy}
                onClick={() => pay(false)}
              >
                לשלם הכול בכסף: {shekel(details.cashOnlyPlan?.cashAgorot ?? details.fullPriceAgorot)}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-stone-600">
                אין ללקוח יתרת שעות זמינה, ולכן התור משולם במחיר הרגיל{plan && plan.discountAgorot > 0 ? " (בניכוי הנחת הזמנה ראשונה)" : ""}.
              </p>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={action.busy}
                onClick={() => pay(true)}
              >
                {action.busy
                  ? "פותח תשלום..."
                  : `תשלום ${shekel(plan?.cashAgorot ?? details.fullPriceAgorot)}`}
              </button>
            </>
          )}
        </section>
      )}

      <button
        type="button"
        className="btn btn-ghost w-full"
        disabled={action.busy}
        onClick={releaseHold}
      >
        ביטול ושחרור החדר
      </button>
    </div>
  );
}
