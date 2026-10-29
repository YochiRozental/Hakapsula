import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { PaymentMethodForm } from "@/components/payment-method-form";
import { getFlowProvider } from "@/lib/payments/flow";
import { isMockCardEnabled } from "@/lib/payments/mock-card-flag";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";

// השער נקרא ממשתני סביבה בזמן ריצה: אסור להכין את העמוד מראש בזמן build
export const dynamic = "force-dynamic";

/** שמירת אמצעי תשלום מדומה (בדיקות בלבד). קיים רק כשהדגל פתוח והספק הוא Mock בסביבת sandbox; אחרת 404 */
export default async function PaymentMethodPage() {
  if (!isMockCardEnabled() || !(getFlowProvider() instanceof MockPaymentProvider)) notFound();
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile/payment-method");
  if (session.user.role === "ADMIN") redirect("/admin");
  if (session.user.mustChangePassword) redirect("/change-password");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader eyebrow="האזור האישי" title="אמצעי תשלום (מדומה)" subtitle="שמירת כרטיס מדומה לבדיקת תשלום בטלפון" />
      <PaymentMethodForm />
    </div>
  );
}
