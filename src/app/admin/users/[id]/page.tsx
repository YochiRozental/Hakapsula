import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { PageHeader } from "@/components/ui";
import { UserCard } from "@/components/user-card";
import { UserActions } from "./user-actions";
import { getFinanceProvider } from "@/lib/finance/gate";

export default async function AdminUserCardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) notFound();

  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      appointments: {
        orderBy: { startTime: "desc" },
        include: { room: { select: { key: true, name: true } } },
      },
    },
  });
  if (!user) notFound();

  return (
    <div>
      <PageHeader
        eyebrow="כרטיס משתמש"
        title={user.name}
        actions={
          <>
            {/* כרטיס כספי: מופיע רק כשהשער FINANCE_ADMIN_ENABLED פתוח */}
            {user.role === "CLIENT" && getFinanceProvider() && (
              <Link href={`/admin/finance/customers/${user.id}`} className="btn btn-primary btn-sm">
                כרטיס כספי
              </Link>
            )}
            <Link href="/admin/users" className="btn btn-secondary btn-sm">
              חזרה לרשימה
            </Link>
          </>
        }
      />
      <UserCard
        user={user}
        // eslint-disable-next-line react-hooks/purity -- server component, rendered once per request
        now={Date.now()}
        actions={<UserActions id={user.id} name={user.name} status={user.status} isSelf={user.id === session.user.id} />}
      />
    </div>
  );
}
