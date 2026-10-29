import { getRuntimeProvider } from "@/lib/payments/runtime";
import type { PaymentProvider } from "@/lib/payments/provider";
import { isFinanceAdminEnabled } from "@/lib/finance/flag";

/** ספק התשלום לצורכי הניהול הכספי, או null אם השער סגור (הדגל כבוי או אין ספק תקף בסביבה) */
export function getFinanceProvider(env: Record<string, string | undefined> = process.env): PaymentProvider | null {
  if (!isFinanceAdminEnabled(env)) return null;
  return getRuntimeProvider(env as NodeJS.ProcessEnv);
}
