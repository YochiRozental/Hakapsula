import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * יומן ביקורת לניהול כספי. נוספות בלבד (טריגר במסד חוסם עדכון ומחיקה). נכתב בתוך אותה טרנזקציה של הפעולה כשאפשר,
 * כך שפעולה מוצלחת ללא רשומה (או להפך) לא קיימת. לעולם לא נשמרים כאן מספר כרטיס, טוקן, סיסמה או קוד IVR:
 * שדות לפני/אחרי עוברים ניקוי לפי שם המפתח.
 */
export type AuditOutcome = "ok" | "rejected" | "error" | "unknown";

export interface AuditEntry {
  action: string;
  adminId?: string | null;
  userId?: string | null;
  entityType: string;
  entityId?: string | null;
  paymentId?: string | null;
  outcome: AuditOutcome;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const SECRET_KEY = /token|password|pin|card|cvv|secret|hash|idempotency/i;

function clean(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!value) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (v instanceof Date) out[k] = v.toISOString();
  }
  return out;
}

type Db = Pick<Prisma.TransactionClient, "auditLog">;

export async function writeAudit(db: Db, e: AuditEntry) {
  return db.auditLog.create({
    data: {
      action: e.action,
      adminId: e.adminId ?? null,
      userId: e.userId ?? null,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      paymentId: e.paymentId ?? null,
      outcome: e.outcome,
      reason: e.reason?.slice(0, 500) ?? null,
      before: clean(e.before),
      after: clean(e.after),
    },
  });
}

/** רישום שאינו מפיל את הפעולה (לתוצאות שכבר התרחשו מול הספק). כשל ברישום נרשם ללוג בלי פרטים */
export async function writeAuditSafe(e: AuditEntry) {
  try {
    await writeAudit(prisma, e);
  } catch (err) {
    console.error("[finance] audit write failed", err instanceof Error ? err.name : "unknown");
  }
}

export interface AuditFilters {
  action?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  take?: number;
}

export async function listAudit(f: AuditFilters = {}) {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(f.action ? { action: f.action } : {}),
      ...(f.userId ? { userId: f.userId } : {}),
      ...(f.entityType ? { entityType: f.entityType } : {}),
      ...(f.entityId ? { entityId: f.entityId } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(f.take ?? 100, 300),
  });
  const ids = [...new Set(rows.flatMap((r) => [r.adminId, r.userId]).filter((x): x is string => !!x))];
  const people = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const name = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    adminName: r.adminId ? (name.get(r.adminId) ?? null) : null,
    userId: r.userId,
    userName: r.userId ? (name.get(r.userId) ?? null) : null,
    entityType: r.entityType,
    entityId: r.entityId,
    paymentId: r.paymentId,
    outcome: r.outcome,
    reason: r.reason,
    before: r.before,
    after: r.after,
    createdAt: r.createdAt.toISOString(),
  }));
}
