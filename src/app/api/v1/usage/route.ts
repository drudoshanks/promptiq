import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getSubscription } from "@/lib/services/billing";
import { countPrompts } from "@/lib/services/prompts";
import { getUsageSummary } from "@/lib/services/usage";

/** GET /api/v1/usage — current-period quota and usage from the server ledger (§11). */
export const GET = withApi({ auth: "required" }, async ({ user }) => {
  const [summary, subscription, savedPrompts] = await Promise.all([
    getUsageSummary(db, user),
    getSubscription(db, user.id),
    countPrompts(db, user.id),
  ]);
  return ok({
    plan: { code: summary.plan.code, name: summary.plan.name },
    period: { start: summary.period.start.toISOString(), end: summary.period.end.toISOString(), source: summary.period.source },
    optimisations: { used: summary.used, limit: summary.limit, remaining: summary.remaining },
    saved_prompts: { used: savedPrompts, limit: summary.plan.maxSavedPrompts },
    tokens: summary.tokens,
    /** Estimated from the price table — not an invoice. */
    estimated_provider_cost_usd: summary.estimatedCostUsd,
    subscription: subscription
      ? {
          status: subscription.status,
          cancel_at_period_end: subscription.cancelAtPeriodEnd,
          current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
        }
      : null,
  });
});
