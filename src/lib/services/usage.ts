import { and, count, eq, gte, lt, sql, sum } from "drizzle-orm";

import { AppError } from "@/lib/api/errors";
import { planFor, type PlanLimits } from "@/lib/config/plans";
import {
  optimisationRuns,
  subscriptions,
  usageEvents,
  type AppUser,
  type OptimisationRun,
  type RunStatus,
} from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

export const USAGE_EVENT_OPTIMISATION = "optimisation";
export const USAGE_EVENT_QUOTA_REJECTED = "quota_rejected";

export interface QuotaPeriod {
  start: Date;
  end: Date;
  source: "billing_period" | "calendar_month";
}

/** Calendar month in UTC; billing period when an active subscription defines one. */
export function calendarMonthPeriod(now = new Date()): QuotaPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, source: "calendar_month" };
}

export async function resolveQuotaPeriod(db: DbOrTx, user: AppUser, now = new Date()): Promise<QuotaPeriod> {
  if (user.planCode === "pro") {
    const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
    if (
      sub &&
      (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due") &&
      sub.currentPeriodStart &&
      sub.currentPeriodEnd &&
      sub.currentPeriodStart <= now &&
      sub.currentPeriodEnd > now
    ) {
      return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd, source: "billing_period" };
    }
  }
  return calendarMonthPeriod(now);
}

export async function countOptimisationsInPeriod(db: DbOrTx, userId: string, period: QuotaPeriod): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.eventType, USAGE_EVENT_OPTIMISATION),
        gte(usageEvents.createdAt, period.start),
        lt(usageEvents.createdAt, period.end),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export interface UsageSummary {
  plan: PlanLimits;
  period: QuotaPeriod;
  used: number;
  limit: number;
  remaining: number;
  estimatedCostUsd: number;
  tokens: { input: number; output: number };
}

export async function getUsageSummary(db: DbOrTx, user: AppUser, now = new Date()): Promise<UsageSummary> {
  const plan = planFor(user.planCode);
  const period = await resolveQuotaPeriod(db, user, now);
  const [row] = await db
    .select({
      units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, user.id),
        eq(usageEvents.eventType, USAGE_EVENT_OPTIMISATION),
        gte(usageEvents.createdAt, period.start),
        lt(usageEvents.createdAt, period.end),
      ),
    );
  const used = Number(row?.units ?? 0);
  return {
    plan,
    period,
    used,
    limit: plan.optimisationsPerPeriod,
    remaining: Math.max(0, plan.optimisationsPerPeriod - used),
    estimatedCostUsd: Number(row?.cost ?? 0),
    tokens: { input: Number(row?.input ?? 0), output: Number(row?.output ?? 0) },
  };
}

/** Throws QUOTA_EXCEEDED when the plan's optimisation quota is spent (FR-013). */
export async function assertQuotaAvailable(db: DbOrTx, user: AppUser, now = new Date()): Promise<{ period: QuotaPeriod; used: number; limit: number }> {
  const plan = planFor(user.planCode);
  const period = await resolveQuotaPeriod(db, user, now);
  const used = await countOptimisationsInPeriod(db, user.id, period);
  if (used >= plan.optimisationsPerPeriod) {
    // Zero-unit ledger entry so operators can see quota pressure/abuse (FR-020).
    await db.insert(usageEvents).values({ userId: user.id, eventType: USAGE_EVENT_QUOTA_REJECTED, units: 0 });
    throw new AppError("QUOTA_EXCEEDED", `You have used all ${plan.optimisationsPerPeriod} optimisations for this period.`, {
      details: {
        limit: plan.optimisationsPerPeriod,
        used,
        resets_at: period.end.toISOString(),
        upgrade_available: user.planCode === "free",
      },
    });
  }
  return { period, used, limit: plan.optimisationsPerPeriod };
}

/** Estimated provider spend across all users for the current UTC day (NFR-012). */
export async function globalSpendTodayUsd(db: DbOrTx, now = new Date()): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ cost: sum(optimisationRuns.estimatedCostUsd) })
    .from(optimisationRuns)
    .where(gte(optimisationRuns.createdAt, dayStart));
  return Number(row?.cost ?? 0);
}

export interface RecordRunInput {
  userId: string;
  provider: string;
  modelId: string;
  templateVersion: string;
  taskCategory: string | null;
  status: RunStatus;
  inputChars: number;
  outputChars?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  estimatedCostUsd?: number | null;
  pricingVersion?: string | null;
  attemptCount?: number;
  latencyMs: number;
  requestId?: string | null;
  errorCode?: string | null;
  promptId?: string | null;
  sourceVersionId?: string | null;
  resultVersionId?: string | null;
}

/** FR-014 usage ledger entry: metadata only, never prompt text. */
export async function recordRun(db: DbOrTx, input: RecordRunInput): Promise<OptimisationRun> {
  const [run] = await db
    .insert(optimisationRuns)
    .values({
      userId: input.userId,
      provider: input.provider,
      modelId: input.modelId,
      templateVersion: input.templateVersion,
      taskCategory: input.taskCategory,
      status: input.status,
      inputChars: input.inputChars,
      outputChars: input.outputChars ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedInputTokens: input.cachedInputTokens ?? null,
      estimatedCostUsd: input.estimatedCostUsd === null || input.estimatedCostUsd === undefined ? null : input.estimatedCostUsd.toFixed(6),
      pricingVersion: input.pricingVersion ?? null,
      attemptCount: Math.max(1, input.attemptCount ?? 1),
      latencyMs: input.latencyMs,
      requestId: input.requestId ?? null,
      errorCode: input.errorCode ?? null,
      promptId: input.promptId ?? null,
      sourceVersionId: input.sourceVersionId ?? null,
      resultVersionId: input.resultVersionId ?? null,
    })
    .returning();
  if (!run) throw new Error("Failed to record run");
  return run;
}

export interface FinaliseRunInput {
  status: RunStatus;
  modelId: string;
  taskCategory?: string | null;
  outputChars?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Sum of the attempts' actual cost; null when any attempt could not be priced. */
  costUsd: number | null;
  pricingVersion: string | null;
  attemptCount: number;
  latencyMs: number;
  requestId?: string | null;
  errorCode?: string | null;
}

/**
 * Close a logical optimisation run with the totals of all its provider attempts
 * (the per-attempt detail lives in api_usage_records).
 */
export async function finaliseRun(db: DbOrTx, runId: string, input: FinaliseRunInput): Promise<OptimisationRun> {
  const [run] = await db
    .update(optimisationRuns)
    .set({
      status: input.status,
      modelId: input.modelId,
      ...(input.taskCategory !== undefined ? { taskCategory: input.taskCategory } : {}),
      outputChars: input.outputChars ?? null,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      estimatedCostUsd: input.costUsd === null ? null : input.costUsd.toFixed(6),
      pricingVersion: input.pricingVersion,
      attemptCount: Math.max(1, input.attemptCount),
      latencyMs: input.latencyMs,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      errorCode: input.errorCode ?? null,
    })
    .where(eq(optimisationRuns.id, runId))
    .returning();
  if (!run) throw new Error("Failed to finalise run");
  return run;
}

export async function linkRunToVersions(db: DbOrTx, runId: string, link: { promptId: string; sourceVersionId: string; resultVersionId: string }): Promise<void> {
  await db
    .update(optimisationRuns)
    .set({ promptId: link.promptId, sourceVersionId: link.sourceVersionId, resultVersionId: link.resultVersionId })
    .where(eq(optimisationRuns.id, runId));
}

/**
 * Consume one unit of quota. The unique idempotency key guarantees a retried
 * request cannot be billed twice; returns false if the key was already used.
 */
export async function recordUsage(db: DbOrTx, input: { userId: string; runId: string; idempotencyKey: string | null; inputTokens: number; outputTokens: number; costUsd: number }): Promise<boolean> {
  const inserted = await db
    .insert(usageEvents)
    .values({
      userId: input.userId,
      runId: input.runId,
      eventType: USAGE_EVENT_OPTIMISATION,
      units: 1,
      inputTokens: Math.max(0, input.inputTokens),
      outputTokens: Math.max(0, input.outputTokens),
      costUsd: Math.max(0, input.costUsd).toFixed(6),
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: usageEvents.idempotencyKey })
    .returning({ id: usageEvents.id });
  return inserted.length > 0;
}

export async function idempotencyKeyUsed(db: DbOrTx, idempotencyKey: string): Promise<{ runId: string | null } | null> {
  const row = await db.query.usageEvents.findFirst({ where: eq(usageEvents.idempotencyKey, idempotencyKey) });
  return row ? { runId: row.runId } : null;
}

export async function getRun(db: DbOrTx, userId: string, runId: string): Promise<OptimisationRun | null> {
  const run = await db.query.optimisationRuns.findFirst({
    where: and(eq(optimisationRuns.id, runId), eq(optimisationRuns.userId, userId)),
  });
  return run ?? null;
}

export async function countRunsForUser(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(optimisationRuns)
    .where(and(eq(optimisationRuns.userId, userId), eq(optimisationRuns.status, "succeeded")));
  return Number(rows[0]?.total ?? 0);
}

export function serialiseRun(run: OptimisationRun) {
  return {
    id: run.id,
    prompt_id: run.promptId,
    source_version_id: run.sourceVersionId,
    result_version_id: run.resultVersionId,
    provider: run.provider,
    model_id: run.modelId,
    template_version: run.templateVersion,
    task_category: run.taskCategory,
    status: run.status,
    input_chars: run.inputChars,
    output_chars: run.outputChars,
    usage: {
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cached_input_tokens: run.cachedInputTokens,
      source: run.inputTokens === null ? "unavailable" : "provider",
    },
    /** Actual usage from the provider, priced with pricing_version (USD). */
    actual_cost_usd: run.estimatedCostUsd === null ? null : Number(run.estimatedCostUsd),
    estimated_cost_usd: run.estimatedCostUsd === null ? null : Number(run.estimatedCostUsd),
    pricing_version: run.pricingVersion,
    attempt_count: run.attemptCount,
    latency_ms: run.latencyMs,
    error_code: run.errorCode,
    created_at: run.createdAt.toISOString(),
  };
}
