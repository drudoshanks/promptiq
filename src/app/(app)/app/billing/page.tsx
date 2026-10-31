import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PlanPicker } from "@/components/billing/plan-picker";
import { PaymentStatusBadge } from "@/components/billing/status-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { PLANS } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import type { PaymentStatus } from "@/lib/db/schema";
import { features } from "@/lib/env";
import { formatInr } from "@/lib/payments/upi";
import { getBillingSubscription, listBillingPlans, listPaymentRequests, serialisePlan } from "@/lib/services/payments";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Billing and payments" };

const ACTION: Record<PaymentStatus, string> = {
  PENDING_PAYMENT: "Continue payment",
  SUBMITTED_FOR_VERIFICATION: "View status",
  UNDER_REVIEW: "View status",
  VERIFIED: "View receipt",
  REJECTED: "Retry payment",
  CANCELLED: "Create new request",
  EXPIRED: "Create new request",
};

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/app/billing");
  const [plans, requests, billing] = await Promise.all([listBillingPlans(db), listPaymentRequests(db, user.id), getBillingSubscription(db, user)]);
  const sub = billing.subscription;
  const active = sub && sub.status === "active";
  const paid = requests.filter((r) => r.r.status === "VERIFIED").reduce((n, r) => n + (r.r.verifiedAmountMinor ?? 0), 0);
  const pending = requests.filter((r) => ["PENDING_PAYMENT", "SUBMITTED_FOR_VERIFICATION", "UNDER_REVIEW"].includes(r.r.status)).reduce((n, r) => n + r.r.expectedAmountMinor, 0);
  const isPro = user.planCode === "pro";
  const endsOn = sub?.current_period_end ? formatDate(sub.current_period_end) : null;

  return (
    <div className="space-y-8">
      <header className="max-w-3xl">
        <h1>Billing and payments</h1>
        <p className="mt-2 text-ink-soft">Pay for Pro with any UPI app. Each payment is checked by hand against our bank records before Pro is switched on, so activation is not instant. Nothing renews or charges automatically.</p>
      </header>

      <section aria-labelledby="current-heading" className="panel grid gap-6 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <h2 id="current-heading" className="sr-only">
          Current plan
        </h2>
        <div>
          <p className="stat-label">Current plan</p>
          <p className="stat-value">{PLANS[user.planCode].name}</p>
        </div>
        <div>
          <p className="stat-label">Subscription</p>
          <p className="mt-1.5">
            {active ? <Badge tone="accent">Active</Badge> : <Badge>{sub ? sub.status.replace("_", " ") : "None"}</Badge>}
            {sub ? <span className="ml-2 text-sm text-ink-soft">{sub.billing_provider === "upi" ? "UPI, manual" : "Card"}</span> : null}
          </p>
        </div>
        <div>
          <p className="stat-label">Period</p>
          <p className="mt-1 text-[0.9375rem]">{sub?.current_period_start && sub.current_period_end ? `${formatDate(sub.current_period_start)} – ${formatDate(sub.current_period_end)}` : "—"}</p>
        </div>
        <div>
          <p className="stat-label">Paid · pending</p>
          <p className="mt-1 text-[0.9375rem] tabular-nums">
            {formatInr(paid || 0).replace("₹0.00", "₹0")} · {formatInr(pending || 0).replace("₹0.00", "₹0")}
          </p>
        </div>
      </section>

      <section id="plans" aria-labelledby="plans-heading" className="scroll-mt-6">
        <h2 id="plans-heading" className="text-lg">
          {isPro ? "Renew Pro" : "Upgrade to Pro"}
        </h2>
        {!features.upiPayments ? (
          <Alert tone="info" className="mt-3">
            UPI payments are not enabled on this deployment yet.
          </Alert>
        ) : null}
        {sub?.billing_provider === "stripe" && active ? (
          <Alert tone="info" className="mt-3">
            You pay for Pro by card. Manage it from <Link href="/app/usage" className="underline">Usage and plan</Link>.
          </Alert>
        ) : (
          <div className="mt-3">
            <PlanPicker plans={plans.map(serialisePlan)} enabled={features.upiPayments} isPro={isPro} renewsUntil={isPro ? endsOn : null} />
          </div>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg">
          Payment history
        </h2>
        {requests.length === 0 ? (
          <p className="panel-soft mt-3 p-6 text-center text-ink-soft">No payments yet. Choose a plan above to start one.</p>
        ) : (
          <div className="panel relative mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {requests.map(({ r, plan }) => (
                  <tr key={r.id}>
                    <td className="font-mono text-sm">{r.paymentReference}</td>
                    <td>{plan.name}</td>
                    <td className="tabular-nums">{formatInr(r.expectedAmountMinor)}</td>
                    <td>
                      <PaymentStatusBadge status={r.status} />
                      {r.status === "REJECTED" && r.rejectionReason ? <p className="mt-1 max-w-xs text-[0.8125rem] text-danger">{r.rejectionReason}</p> : null}
                      {r.infoRequested ? <p className="mt-1 max-w-xs text-[0.8125rem] text-warn">More information requested</p> : null}
                    </td>
                    <td className="text-sm whitespace-nowrap text-ink-soft">{formatDate(r.createdAt)}</td>
                    <td className="text-right">
                      <Link href={r.status === "CANCELLED" || r.status === "EXPIRED" || r.status === "REJECTED" ? "/app/billing#plans" : `/app/billing/pay/${r.id}`} className="btn btn-ghost btn-sm">
                        {ACTION[r.status]}
                      </Link>
                      {r.status === "REJECTED" ? (
                        <Link href={`/app/billing/pay/${r.id}`} className="btn btn-ghost btn-sm">
                          Details
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
