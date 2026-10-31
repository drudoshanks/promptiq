import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PaymentActions } from "@/components/admin/payment-actions";
import { PaymentStatusBadge } from "@/components/billing/status-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { PLANS } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { formatInr } from "@/lib/payments/upi";
import { getAdminPaymentDetail } from "@/lib/services/payments";
import { formatDate, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Payment" };

const ACTION_LABELS: Record<string, string> = {
  marked_under_review: "Marked under review",
  verified: "Verified",
  rejected: "Rejected",
  information_requested: "Requested information",
  recovered: "Recovered and verified",
};

export default async function AdminPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) redirect("/app");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  let d;
  try {
    d = await getAdminPaymentDetail(db, { id: user.id, isAdmin: true }, id);
  } catch {
    notFound();
  }
  const r = d.request;
  const latest = d.submissions[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-ink-soft">
            <Link href="/admin/payments" className="underline">
              Payments
            </Link>{" "}
            / {r.paymentReference}
          </p>
          <h1 className="mt-1 font-mono text-2xl">{r.paymentReference}</h1>
        </div>
        <PaymentStatusBadge status={r.status} />
      </div>

      {r.amountMismatch ? <Alert tone="warning" title="Amount differs">The customer reported {latest ? formatInr(latest.amountMinor) : "a different amount"}; {formatInr(r.expectedAmountMinor)} was expected. Check the bank record carefully.</Alert> : null}
      {r.infoRequested ? <Alert tone="info" title="Waiting for the customer">{r.infoRequestMessage}</Alert> : null}

      <div className="panel p-5">
        <PaymentActions id={r.id} status={r.status} reference={r.paymentReference} expectedAmount={formatInr(r.expectedAmountMinor)} expectedAmountMinor={r.expectedAmountMinor} hasSubmission={d.submissions.length > 0} />
        <p className="mt-3 text-[0.8125rem] text-ink-faint">Never verify because a screenshot or transaction ID was supplied. Find the credit in the business bank statement or UPI merchant app first.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel p-5" aria-labelledby="claim-heading">
          <h2 id="claim-heading" className="text-lg">
            Customer&apos;s claim
          </h2>
          {latest ? (
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Item label="UPI transaction reference" value={latest.transactionReference} mono />
              <Item label="Normalised" value={latest.transactionReferenceNormalized} mono />
              <Item label="Amount reported" value={formatInr(latest.amountMinor)} />
              <Item label="Expected" value={formatInr(r.expectedAmountMinor)} />
              <Item label="Paid at (stated)" value={formatDateTime(latest.paidAt)} />
              <Item label="Submitted" value={formatDateTime(latest.submittedAt)} />
              {latest.userNotes ? <Item label="Notes" value={latest.userNotes} wide /> : null}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">No payment details submitted yet.</p>
          )}
          {latest?.screenshotId ? (
            <figure className="mt-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, auth-checked API image */}
              <img src={`/api/v1/admin/payments/${r.id}/screenshots/${latest.screenshotId}`} alt="Payment screenshot uploaded by the customer" className="max-h-[28rem] rounded-lg border border-line" />
              <figcaption className="mt-1 text-[0.8125rem] text-ink-faint">Uploaded by the customer. Screenshots can be edited; use them only to find the bank record.</figcaption>
            </figure>
          ) : null}
          {d.submissions.length > 1 ? <p className="mt-3 text-sm text-ink-soft">{d.submissions.length - 1} earlier submission{d.submissions.length > 2 ? "s" : ""} for this request.</p> : null}
        </section>

        <section className="panel p-5" aria-labelledby="account-heading">
          <h2 id="account-heading" className="text-lg">
            Account and plan
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Item label="Customer" value={d.user.displayName ?? "—"} />
            <Item label="Email" value={d.user.email ?? "—"} />
            <Item label="Plan requested" value={d.plan.name} />
            <Item label="Expected price" value={formatInr(r.expectedAmountMinor)} />
            <Item label="Current plan" value={PLANS[d.user.planCode].name} />
            <Item label="Subscription" value={d.subscription ? `${d.subscription.billingProvider.toUpperCase()} · ${d.subscription.status}${d.subscription.currentPeriodEnd ? ` until ${formatDate(d.subscription.currentPeriodEnd)}` : ""}` : "None"} />
            <Item label="Paid to" value={`${r.payeeName} (${r.payeeVpa})`} wide />
            <Item label="Request created" value={formatDateTime(r.createdAt)} />
            <Item label="Expires" value={formatDateTime(r.expiresAt)} />
          </dl>
        </section>
      </div>

      <section className="panel p-5" aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="text-lg">
          Review history
        </h2>
        {d.reviews.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No administrator actions yet.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {d.reviews.map((x, i) => (
              <li key={i} className="border-l-2 border-line pl-3 text-sm">
                <p>
                  <span className="font-medium">{ACTION_LABELS[x.review.action] ?? x.review.action}</span> by {x.adminEmail ?? "a removed administrator"} · {formatDateTime(x.review.createdAt)}
                </p>
                {x.review.reason ? <p className="mt-0.5 whitespace-pre-line text-ink-soft">{x.review.reason}</p> : null}
                {x.review.verificationNotes ? <p className="mt-0.5 text-ink-soft">Evidence: {x.review.verificationNotes}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="hist-heading">
        <h2 id="hist-heading" className="text-lg">
          This customer&apos;s payments
        </h2>
        <div className="panel relative mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Plan</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.r.id}>
                  <td className="font-mono text-sm">{h.r.id === r.id ? h.r.paymentReference : <Link href={`/admin/payments/${h.r.id}`}>{h.r.paymentReference}</Link>}</td>
                  <td className="text-sm">{h.plan.name}</td>
                  <td className="tabular-nums">{formatInr(h.r.expectedAmountMinor)}</td>
                  <td>
                    <PaymentStatusBadge status={h.r.status} />
                    {h.r.id === r.id ? <Badge className="ml-1">this one</Badge> : null}
                  </td>
                  <td className="text-sm text-ink-soft">{formatDate(h.r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Item({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`break-words ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
