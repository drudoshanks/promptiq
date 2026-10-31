import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PaymentFlow } from "@/components/billing/payment-flow";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { upiQrSvg } from "@/lib/payments/qr";
import { getBillingSubscription, getOwnedPaymentRequest, serialisePaymentRequest, serialiseSubmission } from "@/lib/services/payments";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Pay with UPI" };

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/app/billing");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let row;
  try {
    row = await getOwnedPaymentRequest(db, user.id, id);
  } catch {
    notFound();
  }
  const payment = serialisePaymentRequest(row.r, row.plan);
  const qrSvg = payment.upi_uri ? await upiQrSvg(payment.upi_uri) : null;
  const billing = await getBillingSubscription(db, user);
  const ends = billing.subscription?.current_period_end ? formatDate(billing.subscription.current_period_end) : null;
  return (
    <PaymentFlow
      key={`${payment.id}:${payment.status}:${row.submissions.length}`}
      payment={{ ...payment, submissions: row.submissions.map(serialiseSubmission) }}
      qrSvg={qrSvg}
      subscriptionEnds={ends}
    />
  );
}
