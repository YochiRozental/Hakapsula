import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { InMemoryMockStore, type MockStore } from "@/lib/payments/mock-store";
import {
  IdempotencyConflictError,
  PaymentStateError,
  WebhookVerificationError,
  type ChargeResult,
  type ChargeSavedMethodInput,
  type CreatePaymentRequestInput,
  type PaymentProvider,
  type PaymentRequestResult,
  type PaymentWebhookEvent,
  type ProviderPaymentStatus,
  type RefundInput,
  type RefundResult,
  type SavedPaymentMethod,
  type VerifiedPaymentStatus,
  type WebhookInput,
} from "@/lib/payments/provider";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

interface MockPayment {
  providerPaymentId: string;
  amountAgorot: number;
  status: ProviderPaymentStatus;
  refundedAgorot: number;
  savePaymentMethod: boolean;
  failureCode?: string;
  savedPaymentMethod?: SavedPaymentMethod;
}

interface IdempotencyEntry {
  fingerprint: string;
  paymentId: string;
}

interface RefundEntry {
  result: RefundResult;
  fingerprint: string;
}

interface TokenEntry {
  declined: boolean;
}

/**
 * ספק מדומה. מדמה את מחזור החיים של תשלום אמיתי: יצירה, השלמה בעמוד המאובטח של הספק (completeCheckout),
 * webhook חתום, שליפת סטטוס, החזרים וחיוב אמצעי שמור. אין לו שום חיבור חיצוני.
 * המצב נשמר ב-MockStore: בזיכרון לבדיקות יחידה, וב-PostgreSQL (PrismaMockStore) כשהאפליקציה רצה, כדי
 * שהפעלה מחדש או בקשה בתהליך אחר לא ישכחו תשלומים. אל תיצרו אותו בקוד אפליקטיבי: רק דרך getPaymentProvider.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly environment = "sandbox" as const;

  constructor(
    private readonly webhookSecret: string,
    private readonly store: MockStore = new InMemoryMockStore()
  ) {}

  async createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestResult> {
    assertPositiveAmount(input.amountAgorot);
    const fingerprint = JSON.stringify([input.amountAgorot, input.currency, input.customerRef, !!input.savePaymentMethod]);
    const idemKey = `idem:${input.idempotencyKey}`;

    const existing = await this.store.get<IdempotencyEntry>(idemKey);
    if (existing) return this.resumeRequest(existing, fingerprint);

    const payment: MockPayment = {
      providerPaymentId: `mock_pay_${randomUUID()}`,
      amountAgorot: input.amountAgorot,
      status: "PENDING",
      refundedAgorot: 0,
      savePaymentMethod: !!input.savePaymentMethod,
    };
    // קודם תופסים את מפתח ה-idempotency ורק אחר כך כותבים את התשלום, כדי שבקשות מקבילות לא ייצרו תשלומים יתומים
    const won = await this.store.putIfAbsent<IdempotencyEntry>(idemKey, { fingerprint, paymentId: payment.providerPaymentId });
    if (!won) {
      // בקשה מקבילה עם אותו מפתח הקדימה אותנו: מחזירים את התשלום שלה
      return this.resumeRequest((await this.store.get<IdempotencyEntry>(idemKey))!, fingerprint);
    }
    await this.store.put(`pay:${payment.providerPaymentId}`, payment);
    return this.toRequestResult(payment);
  }

  async getPaymentStatus(providerPaymentId: string): Promise<VerifiedPaymentStatus> {
    const p = await this.mustGet(providerPaymentId);
    return {
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      amountAgorot: p.amountAgorot,
      refundedAgorot: p.refundedAgorot,
      failureCode: p.failureCode,
      savedPaymentMethod: p.savedPaymentMethod,
    };
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    const p = await this.mustGet(providerPaymentId);
    if (p.status === "CANCELLED") return; // idempotent
    if (p.status !== "PENDING") {
      throw new PaymentStateError("ניתן לבטל רק תשלום שממתין להשלמה (אחרי הצלחה משתמשים בהחזר)");
    }
    p.status = "CANCELLED";
    await this.store.put(`pay:${p.providerPaymentId}`, p);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const fingerprint = JSON.stringify([input.providerPaymentId, input.amountAgorot ?? null]);
    const refundKey = `refund:${input.idempotencyKey}`;
    const prior = await this.store.get<RefundEntry>(refundKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("מפתח idempotency כבר שימש להחזר עם פרמטרים שונים");
      }
      return prior.result;
    }

    const p = await this.mustGet(input.providerPaymentId);
    if (p.status !== "SUCCEEDED") throw new PaymentStateError("ניתן להחזיר רק תשלום שהצליח");
    const remaining = p.amountAgorot - p.refundedAgorot;
    const amount = input.amountAgorot ?? remaining;
    assertPositiveAmount(amount);
    if (amount > remaining) throw new PaymentStateError("סכום ההחזר גדול מהיתרה הניתנת להחזר");

    p.refundedAgorot += amount;
    await this.store.put(`pay:${p.providerPaymentId}`, p);
    const result: RefundResult = { providerRefundId: `mock_ref_${randomUUID()}`, status: "SUCCEEDED", amountAgorot: amount };
    await this.store.put<RefundEntry>(refundKey, { result, fingerprint });
    return result;
  }

  async chargeSavedMethod(input: ChargeSavedMethodInput): Promise<ChargeResult> {
    assertPositiveAmount(input.amountAgorot);
    const fingerprint = JSON.stringify([input.token, input.amountAgorot, input.currency, input.customerRef]);
    const idemKey = `idem:${input.idempotencyKey}`;
    const existing = await this.store.get<IdempotencyEntry>(idemKey);
    if (existing) return this.resumeCharge(existing, fingerprint);

    const token = await this.store.get<TokenEntry>(`token:${input.token}`);
    const declined = !token || token.declined;
    const payment: MockPayment = {
      providerPaymentId: `mock_pay_${randomUUID()}`,
      amountAgorot: input.amountAgorot,
      status: declined ? "FAILED" : "SUCCEEDED",
      refundedAgorot: 0,
      savePaymentMethod: false,
      failureCode: declined ? "card_declined" : undefined,
    };
    const won = await this.store.putIfAbsent<IdempotencyEntry>(idemKey, { fingerprint, paymentId: payment.providerPaymentId });
    if (!won) return this.resumeCharge((await this.store.get<IdempotencyEntry>(idemKey))!, fingerprint);
    await this.store.put(`pay:${payment.providerPaymentId}`, payment);
    return { providerPaymentId: payment.providerPaymentId, status: payment.status, failureCode: payment.failureCode };
  }

  async parseWebhook(input: WebhookInput): Promise<PaymentWebhookEvent> {
    const signature = input.headers[MOCK_SIGNATURE_HEADER];
    if (!signature || !signaturesMatch(signature, this.sign(input.rawBody))) {
      throw new WebhookVerificationError("חתימת webhook לא תקינה");
    }
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new WebhookVerificationError("גוף webhook לא תקין");
    }
    const event = body as Partial<PaymentWebhookEvent>;
    if (
      typeof event.eventId !== "string" ||
      typeof event.providerPaymentId !== "string" ||
      (event.type !== "payment.updated" && event.type !== "refund.updated")
    ) {
      throw new WebhookVerificationError("מבנה webhook לא תקין");
    }
    return { eventId: event.eventId, type: event.type, providerPaymentId: event.providerPaymentId };
  }

  // ---- כלי בדיקה/פיתוח (קיימים רק ב-Mock) ----

  /** מדמה את הלקוח שסיים את עמוד התשלום המאובטח של הספק */
  async completeCheckout(providerPaymentId: string, outcome: "success" | "failure"): Promise<void> {
    const p = await this.mustGet(providerPaymentId);
    if (p.status !== "PENDING") throw new PaymentStateError("התשלום כבר הסתיים");
    if (outcome === "failure") {
      p.status = "FAILED";
      p.failureCode = "card_declined";
    } else {
      p.status = "SUCCEEDED";
      if (p.savePaymentMethod) {
        const token = `mock_tok_${randomUUID()}`;
        await this.store.put<TokenEntry>(`token:${token}`, { declined: false });
        p.savedPaymentMethod = { token, last4: "4242", brand: "mock", expiry: "12/99" };
      }
    }
    await this.store.put(`pay:${p.providerPaymentId}`, p);
  }

  /** טוקן מדומה קיים ולא נדחה. מכיר רק טוקנים שהונפקו כאן (mock_tok_), לעולם לא טוקן של ספק אחר */
  async isPaymentMethodUsable(token: string): Promise<boolean> {
    if (!token.startsWith("mock_tok_")) return false;
    const entry = await this.store.get<TokenEntry>(`token:${token}`);
    return !!entry && !entry.declined;
  }

  /**
   * מנפיק אמצעי תשלום מדומה לבדיקות בלבד, בלי כרטיס ובלי תשלום. הטוקן מתחיל ב-mock_tok_ וניתן לחיוב רק ע"י ספק ה-Mock.
   * אינו חלק מחוזה הספק: ספק אמיתי שומר אמצעי תשלום רק דרך עמוד התשלום המאובטח שלו.
   */
  async issueSandboxToken(): Promise<SavedPaymentMethod> {
    const token = `mock_tok_${randomUUID()}`;
    await this.store.put<TokenEntry>(`token:${token}`, { declined: false });
    return { token, last4: "4242", brand: "mock", expiry: "12/99" };
  }

  /** גורם לחיובים עתידיים באמצעי השמור להידחות */
  async declineToken(token: string): Promise<void> {
    await this.store.put<TokenEntry>(`token:${token}`, { declined: true });
  }

  /** בונה גוף וכותרות של webhook חתום, כפי שספק היה שולח */
  buildWebhook(event: PaymentWebhookEvent): WebhookInput {
    const rawBody = JSON.stringify(event);
    return { rawBody, headers: { [MOCK_SIGNATURE_HEADER]: this.sign(rawBody) } };
  }

  private sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  private async mustGet(id: string): Promise<MockPayment> {
    // הזוכה במפתח idempotency עשוי עוד לא לסיים לכתוב את התשלום: ממתינים קצרות לפני שמדווחים שאינו קיים
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = await this.store.get<MockPayment>(`pay:${id}`);
      if (p) return p;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new PaymentStateError("תשלום לא נמצא");
  }

  private async resumeRequest(entry: IdempotencyEntry, fingerprint: string): Promise<PaymentRequestResult> {
    if (entry.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError("מפתח idempotency כבר שימש לבקשה עם פרמטרים שונים");
    }
    return this.toRequestResult(await this.mustGet(entry.paymentId));
  }

  private async resumeCharge(entry: IdempotencyEntry, fingerprint: string): Promise<ChargeResult> {
    if (entry.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError("מפתח idempotency כבר שימש לחיוב עם פרמטרים שונים");
    }
    const p = await this.mustGet(entry.paymentId);
    return { providerPaymentId: p.providerPaymentId, status: p.status, failureCode: p.failureCode };
  }

  private toRequestResult(p: MockPayment): PaymentRequestResult {
    return {
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      // כתובת סימבולית בלבד: אין עמוד תשלום אמיתי ואין קליטת פרטי כרטיס
      checkoutUrl: `mock://checkout/${p.providerPaymentId}`,
    };
  }
}

function assertPositiveAmount(amountAgorot: number) {
  if (!Number.isInteger(amountAgorot) || amountAgorot <= 0) {
    throw new PaymentStateError("הסכום חייב להיות מספר שלם חיובי של אגורות");
  }
}

function signaturesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
