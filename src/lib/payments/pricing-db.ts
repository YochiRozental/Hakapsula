import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { writeAudit } from "@/lib/finance/audit";
import { FinanceError } from "@/lib/finance/errors";
import type { HoursPackageOption } from "@/lib/payments/pricing";

/** גישה למסד של התמחור הרגיל (שעה בודדת + כרטיסיות 5/10/20 שעות). שורה בודדת, ניתנת לעריכה ע"י מנהל בלבד (שרת בלבד) */

const SINGLETON_ID = "default";

export interface RegularPricingDef {
  hourlyAgorot: number;
  package5Agorot: number;
  package10Agorot: number;
  package20Agorot: number;
  updatedAt: Date;
  updatedById: string | null;
}

type Row = RegularPricingDef & { id: string };

/** התמחור הנוכחי. נקרא מהמסד בכל קריאה (אין Cache בתהליך), כך שעדכון מנהל חל באופן מיידי */
export async function getRegularPricing(db: Pick<PrismaClient, "regularPricing"> = defaultDb): Promise<RegularPricingDef> {
  const row = await db.regularPricing.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) throw new FinanceError("התמחור לא אותחל במסד", "NOT_FOUND");
  return row;
}

export function hoursPackageOptions(p: Pick<RegularPricingDef, "package5Agorot" | "package10Agorot" | "package20Agorot">): HoursPackageOption[] {
  return [
    { hours: 5, priceAgorot: p.package5Agorot },
    { hours: 10, priceAgorot: p.package10Agorot },
    { hours: 20, priceAgorot: p.package20Agorot },
  ];
}

export interface RegularPricingInput {
  hourlyAgorot: number;
  package5Agorot: number;
  package10Agorot: number;
  package20Agorot: number;
}

function positiveAgorot(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FinanceError(`${label} חייב להיות מספר שלם חיובי של אגורות`, "INVALID");
  }
  return value;
}

/** אימות קלט לשמירה. מחזיר את הערכים המנורמלים או זורק FinanceError עם הודעה ברורה */
export function validateRegularPricingInput(input: Record<string, unknown>): RegularPricingInput {
  return {
    hourlyAgorot: positiveAgorot(input.hourlyAgorot, "מחיר שעה בודדת"),
    package5Agorot: positiveAgorot(input.package5Agorot, "מחיר כרטיסיית 5 שעות"),
    package10Agorot: positiveAgorot(input.package10Agorot, "מחיר כרטיסיית 10 שעות"),
    package20Agorot: positiveAgorot(input.package20Agorot, "מחיר כרטיסיית 20 שעות"),
  };
}

/**
 * שמירת התמחור הרגיל. עדכון במקום (אין היסטוריית גרסאות לשורה הזו — לא נדרשת: תשלומים וחבילות קיימים שומרים
 * את המחיר שנקבע להם בזמן הרכישה ב-Payment.amountAgorot / HoursPackage.pricePaidAgorot, ואינם תלויים בשורה הזו
 * אחרי מכן). עדכון חל מיידית על רכישות/הזמנות חדשות. נרשם ביומן הביקורת בתוך אותה טרנזקציה.
 */
export async function saveRegularPricing(params: { adminId: string; input: RegularPricingInput; db?: PrismaClient }): Promise<RegularPricingDef> {
  const { adminId, input, db = defaultDb } = params;
  return db.$transaction(async (tx) => {
    const before = await tx.regularPricing.findUnique({ where: { id: SINGLETON_ID } });
    if (!before) throw new FinanceError("התמחור לא אותחל במסד", "NOT_FOUND");
    const changed = (Object.keys(input) as (keyof RegularPricingInput)[]).some((k) => before[k] !== input[k]);
    if (!changed) return before;
    const updated: Row = await tx.regularPricing.update({ where: { id: SINGLETON_ID }, data: { ...input, updatedById: adminId } });
    await writeAudit(tx, {
      action: "pricing.update",
      adminId,
      entityType: "RegularPricing",
      entityId: SINGLETON_ID,
      outcome: "ok",
      before: { hourlyAgorot: before.hourlyAgorot, package5Agorot: before.package5Agorot, package10Agorot: before.package10Agorot, package20Agorot: before.package20Agorot },
      after: { hourlyAgorot: input.hourlyAgorot, package5Agorot: input.package5Agorot, package10Agorot: input.package10Agorot, package20Agorot: input.package20Agorot },
    });
    return updated;
  });
}
