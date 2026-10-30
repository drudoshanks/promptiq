import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PlanActions } from "@/components/usage/plan-actions";
import { getCurrentUser } from "@/lib/auth/session";
import { PLANS } from "@/lib/config/plans";
import { formatUsd } from "@/lib/cost";
import { db } from "@/lib/db/client";
import { features } from "@/lib/env";
import { getSubscription } from "@/lib/services/billing";
import { countPrompts } from "@/lib/services/prompts";
import { getUsageSummary } from "@/lib/services/usage";
import { formatDate, formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Usage and plan" };

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { checkout } = await searchParams;
  const [usage, subscription, savedPrompts] = await Promise.all([getUsageSummary(db, user), getSubscription(db, user.id), countPrompts(db, user.id)]);
  const percent = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <div className="space-y-8">
      <div>
        <h1>Usage and plan</h1>
        <p className="mt-2 text-ink-soft">Numbers come from the server ledger, the same one that enforces your quota.</p>
      </div>

      {checkout === "success" ? (
        <Alert tone="success" title="Thanks for upgrading">Your plan updates as soon as the payment is confirmed, usually within a minute. Refresh this page if it still shows Free.</Alert>
      ) : null}
      {checkout === "cancelled" ? <Alert tone="info">Checkout was cancelled. Nothing was charged.</Alert> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="panel p-5">
          <h2 className="text-base">This period</h2>
          <p className="mt-3 text-3xl">
            {formatNumber(usage.used)} <span className="text-base text-ink-faint">of {formatNumber(usage.limit)} optimisations</span>
          </p>
          <div className="meter mt-3" role="meter" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used} aria-label="Optimisations used">
            <span style={{ width: `${percent}%` }} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-soft">Period</dt>
            <dd>
              {formatDate(usage.period.start)} to {formatDate(usage.period.end)}
            </dd>
            <dt className="text-ink-soft">Resets</dt>
            <dd>{formatDate(usage.period.end)}</dd>
            <dt className="text-ink-soft">Saved prompts</dt>
            <dd>
              {formatNumber(savedPrompts)} of {formatNumber(usage.plan.maxSavedPrompts)}
            </dd>
            <dt className="text-ink-soft">Tokens this period</dt>
            <dd>
              {formatNumber(usage.tokens.input)} in, {formatNumber(usage.tokens.output)} out
            </dd>
            <dt className="text-ink-soft">Provider cost</dt>
            <dd className="inline-flex flex-wrap items-center gap-2">
              {formatUsd(usage.estimatedCostUsd)} <Badge tone="estimate">estimate</Badge>
            </dd>
          </dl>
          <p className="mt-3 text-sm text-ink-faint">Token counts are the provider&apos;s measured usage for each call where available; cost is estimated from the current price table and is not an invoice.</p>
        </section>

        <section className="panel p-5">
          <h2 className="text-base">Plan</h2>
          <p className="mt-3 text-3xl">{usage.plan.name}</p>
          {subscription ? (
            <p className="mt-1 text-sm text-ink-soft">
              Subscription {subscription.status.replace("_", " ")}
              {subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd ? `, ends ${formatDate(subscription.currentPeriodEnd)}` : subscription.currentPeriodEnd ? `, renews ${formatDate(subscription.currentPeriodEnd)}` : ""}
            </p>
          ) : null}
          <ul className="mt-4 space-y-1 text-[0.9375rem] text-ink-soft">
            <li>{formatNumber(usage.plan.optimisationsPerPeriod)} optimisations per period</li>
            <li>Prompts up to {formatNumber(usage.plan.maxPromptChars)} characters</li>
            <li>
              {formatNumber(usage.plan.maxSavedPrompts)} saved prompts, {usage.plan.maxVersionsPerPrompt} versions each
            </li>
          </ul>
          {user.planCode === "free" ? (
            <p className="mt-4 text-sm text-ink-soft">
              Pro ({PLANS.pro.priceLabel}): {formatNumber(PLANS.pro.optimisationsPerPeriod)} optimisations, prompts up to {formatNumber(PLANS.pro.maxPromptChars)} characters, {formatNumber(PLANS.pro.maxSavedPrompts)} saved prompts.
            </p>
          ) : null}
          <div className="mt-5">
            <PlanActions planCode={user.planCode} billingEnabled={features.billing} hasBillingAccount={Boolean(subscription?.providerCustomerId)} />
          </div>
        </section>
      </div>
    </div>
  );
}
