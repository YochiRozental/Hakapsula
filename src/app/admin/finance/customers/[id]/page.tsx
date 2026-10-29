import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { CustomerFinance } from "@/components/finance/customer-finance";
import { getFinanceProvider } from "@/lib/finance/gate";

export const dynamic = "force-dynamic";

export default async function AdminCustomerFinancePage({ params }: { params: Promise<{ id: string }> }) {
  if (!getFinanceProvider()) notFound();
  const { id } = await params;
  return (
    <div>
      <PageHeader
        eyebrow="ניהול כספי"
        title="כרטיס כספי של לקוח"
        actions={
          <Link href="/admin/finance" className="btn btn-secondary btn-sm">
            חזרה לניהול כספי
          </Link>
        }
      />
      <CustomerFinance id={id} />
    </div>
  );
}
