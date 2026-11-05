"use client";

import type { ReactNode } from "react";
import { setShiftWindowRegistry, type ShiftWindowDef } from "@/lib/shifts/windows";

/**
 * מעביר את המשבצות מהשרת לרכיבים שמציגים שם משבצת לפי מזהה (windowLabel). תצוגה בלבד: כל חישוב עסקי נעשה בשרת.
 * נקרא בזמן רינדור, כדי שגם הרינדור בשרת וגם ההידרציה בדפדפן יראו אותן משבצות.
 */
export function ShiftWindowsProvider({ windows, children }: { windows: ShiftWindowDef[]; children: ReactNode }) {
  setShiftWindowRegistry(windows);
  return <>{children}</>;
}
