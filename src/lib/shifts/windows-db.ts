import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultDb } from "@/lib/prisma";
import { writeAudit } from "@/lib/finance/audit";
import { ShiftError } from "@/lib/shifts/errors";
import { validateWindowInputs, type ShiftWindowDef, type WindowInput } from "@/lib/shifts/windows";

/** גישה למסד של משבצות המשמרת (שרת בלבד). הסדר: sortOrder ואז שעת התחלה */

type Row = { id: string; name: string; startMinutes: number; endMinutes: number; monthlyPriceAgorot: number; active: boolean; sortOrder: number };
const toDef = (r: Row): ShiftWindowDef => ({
  id: r.id,
  name: r.name,
  startMinutes: r.startMinutes,
  endMinutes: r.endMinutes,
  monthlyPriceAgorot: r.monthlyPriceAgorot,
  active: r.active,
  sortOrder: r.sortOrder,
});

export async function listShiftWindows(opts: { activeOnly?: boolean; db?: Pick<PrismaClient, "shiftWindow"> } = {}): Promise<ShiftWindowDef[]> {
  const { activeOnly = false, db = defaultDb } = opts;
  const rows = await db.shiftWindow.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { startMinutes: "asc" }],
  });
  return rows.map(toDef);
}

/** משבצת להזמנה חדשה או לשינוי מאושר: חייבת להתקיים ולהיות פעילה */
export async function requireActiveWindow(
  id: string,
  db: Pick<PrismaClient, "shiftWindow"> = defaultDb,
  opts: { allowInactive?: boolean } = {}
): Promise<ShiftWindowDef> {
  const row = await db.shiftWindow.findUnique({ where: { id } });
  if (!row || (!row.active && !opts.allowInactive)) throw new ShiftError("משבצת שעות לא קיימת או אינה פעילה", "INVALID");
  return toDef(row);
}

const newId = () => `W${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

/**
 * שמירת כל המשבצות בבת אחת (עריכה והוספה; אין מחיקה). עריכה משפיעה רק על הזמנות חדשות ועל שינויים מאושרים:
 * מופעים וחיובים קיימים נשמרים כפי שנקבעו. משבצת שהוסרה מהרשימה מושבתת ולא נמחקת. נרשם ביומן הביקורת.
 */
export async function saveShiftWindows(params: { adminId: string; windows: WindowInput[]; db?: PrismaClient }): Promise<ShiftWindowDef[]> {
  const { adminId, windows, db = defaultDb } = params;
  const problem = validateWindowInputs(windows);
  if (problem) throw new ShiftError(problem, "INVALID");

  await db.$transaction(async (tx) => {
    const existing = await tx.shiftWindow.findMany();
    const byId = new Map(existing.map((w) => [w.id, w]));
    const seen = new Set<string>();
    for (const [index, w] of windows.entries()) {
      if (w.id && !byId.has(w.id)) throw new ShiftError("משבצת לא קיימת", "NOT_FOUND");
      if (w.id && seen.has(w.id)) throw new ShiftError("משבצת מופיעה פעמיים", "INVALID");
      if (w.id) seen.add(w.id);
      const data = {
        name: w.name.trim(),
        startMinutes: w.startMinutes,
        endMinutes: w.endMinutes,
        monthlyPriceAgorot: w.monthlyPriceShekel * 100,
        active: w.active,
        sortOrder: index + 1,
      };
      if (w.id) {
        const before = byId.get(w.id)!;
        const changed = (Object.keys(data) as (keyof typeof data)[]).some((k) => before[k] !== data[k]);
        if (!changed) continue;
        await tx.shiftWindow.update({ where: { id: w.id }, data });
        await writeAudit(tx, {
          action: "shift_window.update",
          adminId,
          entityType: "ShiftWindow",
          entityId: w.id,
          outcome: "ok",
          before: { name: before.name, startMinutes: before.startMinutes, endMinutes: before.endMinutes, monthlyPriceAgorot: before.monthlyPriceAgorot, active: before.active },
          after: data,
        });
      } else {
        const id = newId();
        await tx.shiftWindow.create({ data: { id, ...data } });
        await writeAudit(tx, { action: "shift_window.create", adminId, entityType: "ShiftWindow", entityId: id, outcome: "ok", after: data });
      }
    }
    for (const old of existing) {
      if (!seen.has(old.id) && old.active) {
        await tx.shiftWindow.update({ where: { id: old.id }, data: { active: false } });
        await writeAudit(tx, { action: "shift_window.update", adminId, entityType: "ShiftWindow", entityId: old.id, outcome: "ok", before: { active: true }, after: { active: false } });
      }
    }
  });
  return listShiftWindows({ db });
}
