import { and, count, desc, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";

import { SUGGESTION_KIND_LABELS, toSuggestionKind } from "@/lib/intelligence/categories";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { calculateCost } from "@/lib/cost";
import { apiUsageRecords, optimisationRuns, promptAnalyses, promptSuggestions, promptVersions, prompts } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

import { getCached, setCached } from "./dashboard-cache";
import { getPricingFor } from "./pricing";
import { NEEDS_IMPROVEMENT_SCORE, serialisePrompt } from "./prompts";

/**
 * Token savings are measured ONCE PER PROMPT: the current version against
 * version 1, counted with the same tokenizer. Re-optimising a prompt replaces
 * its saving instead of adding to it, so runs are never double-counted. All
 * savings are text-token estimates, not measured API spend.
 */
export const TOKEN_SAVINGS_DEFINITION =
  "Per prompt: current version compared with the original (version 1), same tokenizer. Counted once per prompt, however many times it was optimised. Estimates from text, not measured API usage.";

async function estimateCostSavings(db: DbOrTx, userId: string) {
  // Sum net tokens saved per target model, then price each group with that
  // model's current input rate. Groups without pricing are reported, not guessed.
  const rawGroups = await db
    .select({
      model: prompts.targetModel,
      saved: sql<number>`coalesce(sum(${prompts.originalTokenCount} - ${prompts.currentTokenCount}), 0)`,
      prompts: count(),
    })
    .from(prompts)
    .where(and(eq(prompts.userId, userId), isNull(prompts.archivedAt), sql`${prompts.currentVersionNumber} > 1`))
    .groupBy(prompts.targetModel);
  // Prompts without a target model are estimated with the default model.
  const merged = new Map<string, { saved: number; prompts: number }>();
  for (const g of rawGroups) {
    const model = g.model ?? DEFAULT_TARGET_MODEL;
    const cur = merged.get(model) ?? { saved: 0, prompts: 0 };
    merged.set(model, { saved: cur.saved + Number(g.saved), prompts: cur.prompts + Number(g.prompts) });
  }
  const groups = [...merged].map(([model, v]) => ({ model, ...v }));

  let total = 0;
  let priced = 0;
  const unpricedModels: string[] = [];
  const pricingVersions: string[] = [];
  for (const g of groups) {
    const pricing = await getPricingFor(db, g.model);
    const cost = calculateCost(pricing, { inputTokens: Math.abs(Number(g.saved)), outputTokens: 0 });
    if (!cost) {
      unpricedModels.push(g.model);
      continue;
    }
    total += Math.sign(Number(g.saved)) * cost.input_cost;
    priced += Number(g.prompts);
    pricingVersions.push(cost.pricing_version);
  }
  return {
    estimated_input_cost_saved_per_request: Math.round(total * 1e10) / 1e10,
    currency: "USD",
    prompts_priced: priced,
    complete: unpricedModels.length === 0,
    unpriced_models: unpricedModels,
    pricing_versions: pricingVersions,
    note: "Estimated input-cost difference for one run of each prompt at current list prices. Not measured savings; output length and request overhead are excluded.",
  };
}

export async function getDashboardSummary(db: DbOrTx, userId: string) {
  const key = `${userId}:summary`;
  const cached = getCached<Awaited<ReturnType<typeof computeSummary>>>(key);
  if (cached) return cached;
  const value = await computeSummary(db, userId);
  setCached(key, value);
  return value;
}

async function computeSummary(db: DbOrTx, userId: string) {
  const active = and(eq(prompts.userId, userId), isNull(prompts.archivedAt));
  const [totals] = await db
    .select({
      total: count(),
      optimised: sql<number>`count(*) filter (where ${prompts.optimisationCount} > 0 or ${prompts.currentVersionNumber} > 1)`,
      needs: sql<number>`count(*) filter (where ${prompts.pendingPriority} >= 2 or ${prompts.latestQualityScore} < ${NEEDS_IMPROVEMENT_SCORE})`,
      pending: sql<number>`coalesce(sum(${prompts.pendingSuggestionCount}), 0)`,
      withPending: sql<number>`count(*) filter (where ${prompts.pendingSuggestionCount} > 0)`,
      favourites: sql<number>`count(*) filter (where ${prompts.isFavourite})`,
      netSaved: sql<number>`coalesce(sum(${prompts.originalTokenCount} - ${prompts.currentTokenCount}) filter (where ${prompts.currentVersionNumber} > 1), 0)`,
      reduced: sql<number>`count(*) filter (where ${prompts.currentTokenCount} < ${prompts.originalTokenCount})`,
      increased: sql<number>`count(*) filter (where ${prompts.currentTokenCount} > ${prompts.originalTokenCount})`,
    })
    .from(prompts)
    .where(active);

  const [recent, attention, costSavings] = await Promise.all([
    db.query.prompts.findMany({ where: active, orderBy: [sql`${prompts.lastUsedAt} DESC NULLS LAST`, desc(prompts.updatedAt)], limit: 5 }),
    db.query.prompts.findMany({
      where: and(active, sql`${prompts.pendingSuggestionCount} > 0`),
      orderBy: [desc(prompts.pendingPriority), desc(prompts.pendingSuggestionCount)],
      limit: 5,
    }),
    estimateCostSavings(db, userId),
  ]);

  return {
    total_prompts: Number(totals?.total ?? 0),
    prompts_optimised: Number(totals?.optimised ?? 0),
    prompts_needing_improvement: Number(totals?.needs ?? 0),
    pending_suggestions: Number(totals?.pending ?? 0),
    prompts_with_pending_suggestions: Number(totals?.withPending ?? 0),
    favourites: Number(totals?.favourites ?? 0),
    tokens_saved: {
      net_tokens_saved: Number(totals?.netSaved ?? 0),
      prompts_reduced: Number(totals?.reduced ?? 0),
      prompts_increased: Number(totals?.increased ?? 0),
      kind: "estimate" as const,
      definition: TOKEN_SAVINGS_DEFINITION,
    },
    estimated_cost_savings: costSavings,
    recently_used: recent.map(serialisePrompt),
    prompts_with_pending: attention.map(serialisePrompt),
    generated_at: new Date().toISOString(),
  };
}

export type DashboardSummary = Awaited<ReturnType<typeof getDashboardSummary>>;

export async function getDashboardAnalytics(db: DbOrTx, userId: string, now = new Date()) {
  const key = `${userId}:analytics`;
  const cached = getCached<Awaited<ReturnType<typeof computeAnalytics>>>(key);
  if (cached) return cached;
  const value = await computeAnalytics(db, userId, now);
  setCached(key, value);
  return value;
}

async function computeAnalytics(db: DbOrTx, userId: string, now: Date) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [analysed] = await db
    .select({ n: sql<number>`count(distinct ${promptAnalyses.promptId})`, analyses: count() })
    .from(promptAnalyses)
    .where(and(eq(promptAnalyses.userId, userId), eq(promptAnalyses.status, "completed")));

  const suggestionRows = await db
    .select({ status: promptSuggestions.status, category: promptSuggestions.category, n: count() })
    .from(promptSuggestions)
    .where(eq(promptSuggestions.userId, userId))
    .groupBy(promptSuggestions.status, promptSuggestions.category);
  const byStatus: Record<string, number> = { pending: 0, accepted: 0, dismissed: 0, deferred: 0, applied: 0 };
  const byCategory: Record<string, { label: string; accepted: number; dismissed: number; total: number }> = {};
  for (const r of suggestionRows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
    const c = (byCategory[r.category] ??= { label: SUGGESTION_KIND_LABELS[toSuggestionKind(r.category)], accepted: 0, dismissed: 0, total: 0 });
    c.total += Number(r.n);
    if (r.status === "accepted" || r.status === "applied") c.accepted += Number(r.n);
    if (r.status === "dismissed") c.dismissed += Number(r.n);
  }

  // Per-run figures (each successful optimisation's own before/after).
  const runStats = await db
    .select({
      mode: optimisationRuns.optimisationMode,
      runs: count(),
      avgReduction: sql<number>`avg(${optimisationRuns.reductionPercent})`,
      saved: sql<number>`coalesce(sum(${optimisationRuns.tokensSaved}), 0)`,
    })
    .from(optimisationRuns)
    .where(and(eq(optimisationRuns.userId, userId), eq(optimisationRuns.status, "succeeded")))
    .groupBy(optimisationRuns.optimisationMode);

  // Per-prompt figure (current vs original), the one used for "tokens saved".
  const [perPrompt] = await db
    .select({
      prompts: count(),
      avgReduction: sql<number>`avg((${prompts.originalTokenCount} - ${prompts.currentTokenCount})::numeric / nullif(${prompts.originalTokenCount}, 0) * 100)`,
    })
    .from(prompts)
    .where(and(eq(prompts.userId, userId), isNull(prompts.archivedAt), sql`${prompts.currentVersionNumber} > 1`));

  const categories = await db
    .select({ category: prompts.category, n: count() })
    .from(prompts)
    .where(and(eq(prompts.userId, userId), isNull(prompts.archivedAt)))
    .groupBy(prompts.category)
    .orderBy(desc(count()))
    .limit(6);

  const usage = await db
    .select({
      type: apiUsageRecords.requestType,
      calls: count(),
      input: sql<number>`coalesce(sum(${apiUsageRecords.actualInputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${apiUsageRecords.actualOutputTokens}), 0)`,
      cost: sql<string | null>`sum(${apiUsageRecords.actualCost})`,
    })
    .from(apiUsageRecords)
    .where(and(eq(apiUsageRecords.userId, userId), gte(apiUsageRecords.createdAt, since)))
    .groupBy(apiUsageRecords.requestType);

  // Recent activity: titles and event types only, never prompt text.
  const [versions, analyses, runs] = await Promise.all([
    db
      .select({ at: promptVersions.createdAt, promptId: prompts.id, title: prompts.title, provenance: promptVersions.provenance, number: promptVersions.versionNumber })
      .from(promptVersions)
      .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
      .where(eq(prompts.userId, userId))
      .orderBy(desc(promptVersions.createdAt))
      .limit(10),
    db
      .select({ at: promptAnalyses.completedAt, promptId: prompts.id, title: prompts.title, score: promptAnalyses.qualityScore })
      .from(promptAnalyses)
      .innerJoin(prompts, eq(prompts.id, promptAnalyses.promptId))
      .where(and(eq(promptAnalyses.userId, userId), eq(promptAnalyses.status, "completed"), isNotNull(promptAnalyses.completedAt)))
      .orderBy(desc(promptAnalyses.completedAt))
      .limit(10),
    db
      .select({ at: optimisationRuns.createdAt, promptId: prompts.id, title: prompts.title, mode: optimisationRuns.optimisationMode, saved: optimisationRuns.tokensSaved, status: optimisationRuns.status })
      .from(optimisationRuns)
      .innerJoin(prompts, eq(prompts.id, optimisationRuns.promptId))
      .where(eq(optimisationRuns.userId, userId))
      .orderBy(desc(optimisationRuns.createdAt))
      .limit(10),
  ]);
  const activity = [
    ...versions.map((v) => ({ at: v.at, prompt_id: v.promptId, prompt_title: v.title, type: "version" as const, detail: `Version ${v.number} (${v.provenance.replace(/_/g, " ")})` })),
    ...analyses.map((a) => ({ at: a.at as Date, prompt_id: a.promptId, prompt_title: a.title, type: "analysis" as const, detail: a.score === null ? "Analysed" : `Analysed, score ${a.score}` })),
    ...runs.map((r) => ({ at: r.at, prompt_id: r.promptId, prompt_title: r.title, type: "optimisation" as const, detail: `${r.mode.replace(/_/g, " ")} optimisation ${r.status}${r.saved !== null ? `, ${r.saved >= 0 ? `${r.saved} tokens fewer` : `${-r.saved} tokens more`}` : ""}` })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 15)
    .map((e) => ({ ...e, at: e.at.toISOString() }));

  return {
    prompts_analysed: Number(analysed?.n ?? 0),
    analyses_completed: Number(analysed?.analyses ?? 0),
    suggestions: { by_status: byStatus, by_category: byCategory },
    optimisation_runs: {
      by_mode: runStats.map((r) => ({ mode: r.mode, runs: Number(r.runs), average_reduction_percent: r.avgReduction === null ? null : Math.round(Number(r.avgReduction) * 10) / 10, tokens_saved_sum_per_run: Number(r.saved) })),
      definition: "Per run: each successful optimisation compared with the text it started from. Repeated runs on one prompt each count here; use per-prompt figures for totals.",
    },
    per_prompt: {
      prompts_with_new_versions: Number(perPrompt?.prompts ?? 0),
      average_reduction_percent: perPrompt?.avgReduction === null || perPrompt?.avgReduction === undefined ? null : Math.round(Number(perPrompt.avgReduction) * 10) / 10,
      definition: TOKEN_SAVINGS_DEFINITION,
    },
    top_categories: categories.map((c) => ({ category: c.category, prompts: Number(c.n) })),
    promptiq_usage_last_30_days: usage.map((u) => ({
      request_type: u.type,
      calls: Number(u.calls),
      input_tokens: Number(u.input),
      output_tokens: Number(u.output),
      actual_cost: u.cost === null ? null : Number(u.cost),
      kind: "actual" as const,
    })),
    recent_activity: activity,
    generated_at: now.toISOString(),
  };
}

export type DashboardAnalytics = Awaited<ReturnType<typeof getDashboardAnalytics>>;

/** Optimisation history across the library, newest first (no prompt text). */
export async function listOptimisationHistory(db: DbOrTx, userId: string, page: number, pageSize: number) {
  const where = and(eq(optimisationRuns.userId, userId), isNotNull(optimisationRuns.promptId));
  const [rows, totals] = await Promise.all([
    db
      .select({ run: optimisationRuns, title: prompts.title })
      .from(optimisationRuns)
      .innerJoin(prompts, eq(prompts.id, optimisationRuns.promptId))
      .where(where)
      .orderBy(desc(optimisationRuns.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(optimisationRuns).where(where),
  ]);
  return {
    items: rows.map(({ run, title }) => ({
      id: run.id,
      prompt_id: run.promptId,
      prompt_title: title,
      status: run.status,
      optimisation_mode: run.optimisationMode,
      target_model: run.targetModel,
      tokens_saved: run.tokensSaved,
      reduction_percent: run.reductionPercent === null ? null : Number(run.reductionPercent),
      estimated_input_cost_before: run.estimatedInputCostBefore === null ? null : Number(run.estimatedInputCostBefore),
      estimated_input_cost_after: run.estimatedInputCostAfter === null ? null : Number(run.estimatedInputCostAfter),
      saved_as_version: Boolean(run.resultVersionId),
      applied_suggestion_count: run.appliedSuggestionCount,
      actual_cost_usd: run.estimatedCostUsd === null ? null : Number(run.estimatedCostUsd),
      created_at: run.createdAt.toISOString(),
    })),
    total: Number(totals[0]?.n ?? 0),
    page,
    page_size: pageSize,
  };
}
