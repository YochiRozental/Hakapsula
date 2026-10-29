import { getRuntimeProvider } from "@/lib/payments/runtime";
import type { PaymentProvider } from "@/lib/payments/provider";
import { isShiftsEnabled } from "@/lib/shifts/flag";

/** ספק התשלום לצורכי משמרות, או null אם השער סגור (הדגל כבוי או אין ספק תקף בסביבה) */
export function getShiftsProvider(env: Record<string, string | undefined> = process.env): PaymentProvider | null {
  if (!isShiftsEnabled(env)) return null;
  return getRuntimeProvider(env as NodeJS.ProcessEnv);
}
