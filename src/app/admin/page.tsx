import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { formatUsd } from "@/lib/cost";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getAdminMetrics } from "@/lib/services/admin";
import { formatDateTime, formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Operations" };
export const dynamic = "force-dynamic";

/** Minimal operator screen (FR-020, §11): aggregates only, never prompt text. */
export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/admin");
  if (!user.isAdmin) redirect("/app");

  logger.info("admin page viewed", { operator_id: user.id });
  const metrics = await getAdminMetrics(db);

  const windows = [
    { label: "Last 24 hours", data: metrics.runs.last_24h },
    { label: "Last 7 days", data: metrics.runs.last_7d },
  ];

  return (
    <div className="min-h-dvh">
      <AppNav email={user.email} isAdmin />
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <div>
          <h1>Operations</h1>
          <p className="mt-2 text-ink-soft">
            Aggregate health and cost. Generated {formatDateTime(metrics.generated_at)}. Provider: {env.OPTIMISER_PROVIDER} ({env.OPTIMISER_MODEL}); daily spend cap {formatUsd(env.GLOBAL_DAILY_SPEND_CAP_USD, 2)}.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {windows.map(({ label, data }) => (
            <section key={label} className="panel p-5">
              <h2 className="text-base">{label}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-soft">Optimisation runs</dt>
                <dd>{formatNumber(data.total_runs)}</dd>
                <dt className="text-ink-soft">Failure rate</dt>
                <dd>{(data.failure_rate * 100).toFixed(1)}%</dd>
                <dt className="text-ink-soft">p95 latency</dt>
                <dd>{formatNumber(data.p95_latency_ms)} ms</dd>
                <dt className="text-ink-soft">Estimated provider cost</dt>
                <dd className="inline-flex items-center gap-2">
                  {formatUsd(data.estimated_cost_usd)} <Badge tone="estimate">estimate</Badge>
                </dd>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(data.by_status).map(([status, count]) => (
                  <Badge key={status} tone={status === "succeeded" ? "accent" : status === "failed" ? "danger" : "neutral"}>
                    {status}: {formatNumber(count)}
                  </Badge>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <section className="panel p-5">
            <h2 className="text-base">Accounts</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-soft">Total</dt>
              <dd>{formatNumber(metrics.users.total)}</dd>
              <dt className="text-ink-soft">Pro</dt>
              <dd>{formatNumber(metrics.users.pro)}</dd>
              <dt className="text-ink-soft">Deleted</dt>
              <dd>{formatNumber(metrics.users.pending_deletion)}</dd>
            </dl>
          </section>
          <section className="panel p-5">
            <h2 className="text-base">Quota pressure (24h)</h2>
            <p className="mt-3 text-2xl">{formatNumber(metrics.abuse_signals.quota_rejections_24h)}</p>
            <p className="text-sm text-ink-soft">requests rejected for exceeding plan quota</p>
            <h3 className="mt-4 text-sm font-medium text-ink-soft">Heaviest accounts</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {metrics.abuse_signals.top_users_24h.length === 0 ? <li className="text-ink-faint">No activity.</li> : null}
              {metrics.abuse_signals.top_users_24h.map((u) => (
                <li key={u.user_id} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-xs">{u.user_id}</span>
                  <span>{formatNumber(u.optimisations)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel p-5">
            <h2 className="text-base">Billing webhooks (7d)</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-soft">Failed</dt>
              <dd>{formatNumber(metrics.billing_webhooks_7d.failed)}</dd>
              <dt className="text-ink-soft">Unprocessed</dt>
              <dd>{formatNumber(metrics.billing_webhooks_7d.pending)}</dd>
            </dl>
            <p className="mt-3 text-sm text-ink-soft">Replay failed events from the Stripe dashboard; processing is idempotent. Procedure: docs/runbooks.md in the repository.</p>
          </section>
        </div>

        <p className="text-sm text-ink-faint">Operator views are audited. Prompt content is never shown here; break-glass access to a user&apos;s data requires a documented incident ticket.</p>
      </main>
    </div>
  );
}
