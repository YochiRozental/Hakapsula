import { notFound } from "next/navigation";
import { Checkout } from "@/components/payments/checkout";
import { getFlowProvider } from "@/lib/payments/flow";

/** מסך השלמת תשלום להחזקה. קיים רק כשזרימת התשלום פעילה (סביבת פיתוח); אחרת 404. ההתחברות נאכפת ב-middleware */
// השער נקרא ממשתני סביבה בזמן ריצה: אסור להכין את העמוד מראש בזמן build
export const dynamic = "force-dynamic";

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  if (!getFlowProvider()) notFound();
  const { id } = await params;
  return <Checkout appointmentId={id} />;
}
