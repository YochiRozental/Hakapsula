import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getMissingBookingDetails } from "@/lib/profile";
import { safeInternalPath } from "@/lib/safe-path";
import { CompleteProfileForm } from "./complete-profile-form";

export default async function CompleteProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; edit?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/complete-profile");
  if (session.user.role === "ADMIN") redirect("/admin");

  const { next, edit } = await searchParams;
  const isEdit = edit === "1";
  const nextPath = safeInternalPath(next, isEdit ? "/profile" : "/booking");

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) redirect("/login");

  // אין מה להשלים — חוזרים ישר לתהליך ההזמנה
  if (!isEdit && getMissingBookingDetails(user).length === 0) redirect(nextPath);

  return (
    <CompleteProfileForm
      nextPath={nextPath}
      isEdit={isEdit}
      initial={{
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        phone: user.phone ?? "",
        idNumber: user.idNumber ?? "",
        gender: user.gender ?? "",
        cardExpiry: user.cardExpiry ?? "",
      }}
      cardLast4={user.cardLast4}
    />
  );
}
