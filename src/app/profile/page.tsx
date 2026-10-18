import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { UserCard } from "@/components/user-card";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile");
  if (session.user.role === "ADMIN") redirect("/admin");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      appointments: {
        orderBy: { startTime: "desc" },
        include: { room: { select: { key: true, name: true } } },
      },
    },
  });
  if (!user) redirect("/login");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        eyebrow="האזור האישי"
        title="כרטיס הלקוח שלי"
        actions={
          <Link href="/complete-profile?edit=1&next=/profile" className="btn btn-primary btn-sm">
            עריכת פרטים
          </Link>
        }
      />
      {/* eslint-disable-next-line react-hooks/purity -- server component, rendered once per request */}
      <UserCard user={user} now={Date.now()} />
    </div>
  );
}
