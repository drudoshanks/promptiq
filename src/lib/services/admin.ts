import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { appUsers, optimisationRuns, usageEvents, webhookEvents } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

/**
 * Aggregate operator metrics (FR-020). Never touches prompt text; user
 * identifiers in abuse signals are opaque app_users IDs, not emails.
 */
export async function getAdminMetrics(db: DbOrTx, now = new Date()) {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const window = async (since: Date) => {
    const rows = await db
      .select({
        status: optimisationRuns.status,
        runs: count(),
        cost: sql<string>`coalesce(sum(${optimisationRuns.estimatedCostUsd}), 0)`,
        p95: sql<number>`percentile_cont(0.95) within group (order by ${optimisationRuns.latencyMs})`,
      })
      .from(optimisationRuns)
      .where(gte(optimisationRuns.createdAt, since))
      .groupBy(optimisationRuns.status);
    const total = rows.reduce((n, r) => n + Number(r.runs), 0);
    const succeeded = Number(rows.find((r) => r.status === "succeeded")?.runs ?? 0);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.runs)]));
    const cost = rows.reduce((n, r) => n + Number(r.cost), 0);
    const p95 = rows.reduce((max, r) => Math.max(max, Number(r.p95 ?? 0)), 0);
    return {
      total_runs: total,
      succeeded,
      failure_rate: total ? Math.round(((total - succeeded) / total) * 1000) / 1000 : 0,
      by_status: byStatus,
      estimated_cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
      p95_latency_ms: Math.round(p95),
    };
  };

  const [last24h, last7d] = await Promise.all([window(dayAgo), window(weekAgo)]);

  const [users] = await db
    .select({
      total: count(),
      pro: sql<number>`count(*) filter (where ${appUsers.planCode} = 'pro')`,
      deleted: sql<number>`count(*) filter (where ${appUsers.deletedAt} is not null)`,
    })
    .from(appUsers);

  const topUsers = await db
    .select({ user_id: usageEvents.userId, units: sql<number>`sum(${usageEvents.units})` })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, dayAgo), eq(usageEvents.eventType, "optimisation")))
    .groupBy(usageEvents.userId)
    .orderBy(desc(sql`sum(${usageEvents.units})`))
    .limit(5);

  const [quotaSignals] = await db
    .select({ failed_quota: count() })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, dayAgo), eq(usageEvents.eventType, "quota_rejected")));

  const [webhooks] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${webhookEvents.processingStatus} = 'failed')`,
      pending: sql<number>`count(*) filter (where ${webhookEvents.processingStatus} = 'received')`,
    })
    .from(webhookEvents)
    .where(gte(webhookEvents.createdAt, weekAgo));

  return {
    generated_at: now.toISOString(),
    runs: { last_24h: last24h, last_7d: last7d },
    users: {
      total: Number(users?.total ?? 0),
      pro: Number(users?.pro ?? 0),
      pending_deletion: Number(users?.deleted ?? 0),
    },
    abuse_signals: {
      top_users_24h: topUsers.map((r) => ({ user_id: r.user_id, optimisations: Number(r.units) })),
      quota_rejections_24h: Number(quotaSignals?.failed_quota ?? 0),
    },
    billing_webhooks_7d: { failed: Number(webhooks?.failed ?? 0), pending: Number(webhooks?.pending ?? 0) },
  };
}

export type AdminMetrics = Awaited<ReturnType<typeof getAdminMetrics>>;
