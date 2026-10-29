import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { IvrPinForm } from "@/components/ivr-pin-form";
import { isIvrPinSetupEnabled } from "@/lib/ivr-pin/flag";

// השער נקרא ממשתני סביבה בזמן ריצה: אסור להכין את העמוד מראש בזמן build
export const dynamic = "force-dynamic";

/** הגדרת קוד טלפוני. קיים רק כשהשער פתוח (IVR_PIN_SETUP_ENABLED=true); אחרת 404 */
export default async function IvrPinPage() {
  if (!isIvrPinSetupEnabled()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/profile/ivr-pin");
  if (session.user.role === "ADMIN") redirect("/admin");
  if (session.user.mustChangePassword) redirect("/change-password");

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader eyebrow="האזור האישי" title="קוד טלפוני" subtitle="קוד זיהוי לשיחות טלפון, נפרד מסיסמת האתר" />
      <IvrPinForm />
    </div>
  );
}
