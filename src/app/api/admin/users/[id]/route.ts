import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { prisma } from "@/lib/prisma";
import { sendApprovalNotification } from "@/lib/notifications";
import { writeAudit } from "@/lib/finance/audit";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const role = body?.role as "ADMIN" | "CLIENT" | undefined;
  const status = body?.status as "PENDING" | "APPROVED" | "BLOCKED" | undefined;

  if (role === undefined && status === undefined) {
    return NextResponse.json({ error: "אין נתונים לעדכון" }, { status: 400 });
  }
  if (role !== undefined && role !== "ADMIN" && role !== "CLIENT") {
    return NextResponse.json({ error: "תפקיד לא תקין" }, { status: 400 });
  }
  if (status !== undefined && !["PENDING", "APPROVED", "BLOCKED"].includes(status)) {
    return NextResponse.json({ error: "סטטוס לא תקין" }, { status: 400 });
  }
  if (id === session.user.id && (role === "CLIENT" || status === "BLOCKED")) {
    return NextResponse.json({ error: "לא ניתן לבצע פעולה זו על החשבון של עצמך" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { id },
    select: { status: true, name: true, email: true, phone: true },
  });
  if (!existing) return NextResponse.json({ error: "משתמש לא נמצא" }, { status: 404 });

  // שינוי סטטוס שנוגע בחסימה (כניסה ל-BLOCKED או יציאה ממנה) נרשם ביומן הביקורת הכספי באותה טרנזקציה, בדיוק כמו בחסימה
  // דרך הניהול הכספי. אין כתיבה כשהסטטוס לא השתנה בפועל, ולכן שליחה חוזרת של אותה בקשה לא יוצרת רשומה כפולה
  const blockChange = status !== undefined && status !== existing.status && (status === "BLOCKED" || existing.status === "BLOCKED");
  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id },
      data: { ...(role !== undefined && { role }), ...(status !== undefined && { status }) },
      select: { id: true, name: true, email: true, phone: true, role: true, status: true },
    });
    if (blockChange) {
      await writeAudit(tx, {
        action: status === "BLOCKED" ? "CUSTOMER_BLOCKED" : "CUSTOMER_UNBLOCKED",
        adminId: session.user.id,
        userId: id,
        entityType: "User",
        entityId: id,
        outcome: "ok",
        reason: "admin_users_screen",
        before: { status: existing.status },
        after: { status },
      });
    }
    return updated;
  });

  if (status === "APPROVED" && existing.status !== "APPROVED") {
    try {
      await sendApprovalNotification(user);
    } catch (err) {
      console.error("[admin/users] failed to send approval notification", err);
    }
  }

  return NextResponse.json(user);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await params;

  if (id === session.user.id) {
    return NextResponse.json({ error: "לא ניתן למחוק את החשבון של עצמך" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "משתמש לא נמצא" }, { status: 404 });

  await prisma.user.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
