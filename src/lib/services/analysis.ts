import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { ANALYSIS_TEMPLATE_VERSION } from "@/lib/analysis/instructions";
import { SUGGESTION_CATEGORY_LABELS, type SuggestionCategory } from "@/lib/analysis/schema";
import { AppError, notFound } from "@/lib/api/errors";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import {
  promptAnalyses,
  promptSuggestions,
  prompts,
  type AppUser,
  type PromptAnalysis,
  type PromptSuggestion,
  type SuggestionStatus,
} from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import type { RequestLogger } from "@/lib/logger";
import { userKeyFor } from "@/lib/optimiser/service";
import { ProviderError, type PromptAnalyser, type ProviderAttempt } from "@/lib/providers/types";

import { recordApiUsage, summariseUsage } from "./estimates";
import { getFeedbackHistory, getPromptPreferences } from "./prompt-preferences";
import { getPrompt, refreshPromptStats } from "./prompts";
import { assertAnalysisQuotaAvailable, globalSpendTodayUsd, recordAnalysisUsage } from "./usage";

export interface AnalyseContext {
  db: Db;
  user: AppUser;
  provider: PromptAnalyser;
  requestId: string;
  log: RequestLogger;
  globalDailySpendCapUsd: number;
}

export interface AnalysePromptInput {
  promptId: string;
  /** Defaults to the current (newest) version. */
  versionId?: string | null;
  /** Re-run even when this version already has a completed analysis. */
  force?: boolean;
}

export interface AnalysisWithSuggestions {
  analysis: PromptAnalysis;
  suggestions: PromptSuggestion[];
  /** True when an existing analysis of the same version was returned (no new AI call). */
  reused: boolean;
}

async function loadSuggestions(db: DbOrTx, analysisId: string): Promise<PromptSuggestion[]> {
  return db.query.promptSuggestions.findMany({ where: eq(promptSuggestions.analysisId, analysisId), orderBy: [asc(promptSuggestions.position)] });
}

/**
 * Analyse one saved prompt version and store suggestions linked to that
 * version (Prompt Library §5–6). Only that version's text is sent to the
 * provider. Re-analysing an unchanged version reuses the stored result unless
 * `force` is set, so the same work is never paid for twice by accident.
 */
export async function analysePrompt(ctx: AnalyseContext, input: AnalysePromptInput): Promise<AnalysisWithSuggestions> {
  const { db, user, provider, log } = ctx;
  const prompt = await getPrompt(db, user.id, input.promptId);
  const version = input.versionId ? prompt.versions.find((v) => v.id === input.versionId) : prompt.versions[prompt.versions.length - 1];
  if (!version) throw notFound("Version");

  const existing = await db.query.promptAnalyses.findFirst({
    where: and(eq(promptAnalyses.promptVersionId, version.id), inArray(promptAnalyses.status, ["completed", "running"])),
    orderBy: [desc(promptAnalyses.createdAt)],
  });
  if (existing?.status === "running") {
    throw new AppError("CONFLICT", "An analysis of this version is already running.", { details: { analysis_id: existing.id } });
  }
  if (existing && !input.force) {
    return { analysis: existing, suggestions: await loadSuggestions(db, existing.id), reused: true };
  }

  if (version.promptText.length > planFor(user.planCode).maxPromptChars) {
    throw new AppError("PROMPT_TOO_LONG", "This prompt is longer than your plan allows for analysis.");
  }
  await assertAnalysisQuotaAvailable(db, user);
  if (ctx.globalDailySpendCapUsd > 0 && (await globalSpendTodayUsd(db)) >= ctx.globalDailySpendCapUsd) {
    throw new AppError("SPEND_CAP_REACHED", "Analysis is temporarily paused. Please try again later.");
  }

  const targetModel = prompt.targetModel ?? DEFAULT_TARGET_MODEL;
  let analysis: PromptAnalysis;
  try {
    const [row] = await db
      .insert(promptAnalyses)
      .values({
        userId: user.id,
        promptId: prompt.id,
        promptVersionId: version.id,
        status: "running",
        targetModel,
        modelId: provider.modelId,
        templateVersion: ANALYSIS_TEMPLATE_VERSION,
      })
      .returning();
    if (!row) throw new Error("Failed to start analysis");
    analysis = row;
  } catch (error) {
    // The partial unique index rejects a concurrent second run for this version.
    if (error instanceof Error && /idx_analyses_one_running|unique/i.test(`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
      throw new AppError("CONFLICT", "An analysis of this version is already running.");
    }
    throw error;
  }

  const prefs = await getPromptPreferences(db, user.id);
  const feedbackHistory = prefs.learnFromFeedback ? await getFeedbackHistory(db, user.id) : {};

  const recordAttempts = async (attempts: ProviderAttempt[]) => {
    const rows = [];
    for (const a of attempts) {
      const recorded = await recordApiUsage(db, {
        userId: user.id,
        runId: null,
        analysisId: analysis.id,
        attempt: a.attempt,
        provider: provider.name,
        modelId: a.modelId,
        requestType: "prompt_analysis",
        providerRequestId: a.providerRequestId ?? null,
        status: a.status,
        inputTokens: a.usage?.inputTokens ?? 0,
        outputTokens: a.usage?.outputTokens ?? 0,
        cachedInputTokens: a.usage?.cachedInputTokens ?? null,
        usageReported: a.usage !== null,
      });
      if (recorded) rows.push(recorded.record);
    }
    return summariseUsage(rows);
  };
  const fail = async (attempts: ProviderAttempt[], code: string) => {
    const usage = await recordAttempts(attempts);
    await db
      .update(promptAnalyses)
      .set({
        status: "failed",
        errorCode: code,
        completedAt: new Date(),
        inputTokens: usage.total_input_tokens,
        outputTokens: usage.total_output_tokens,
        actualCost: usage.actual_cost === null ? null : usage.actual_cost.toFixed(10),
      })
      .where(eq(promptAnalyses.id, analysis.id));
  };

  let result;
  try {
    result = await provider.analyse({
      prompt: version.promptText,
      targetModel,
      preferences: {
        preferred_style: prefs.preferredStyle,
        preferred_response_length: prefs.preferredResponseLength,
        token_efficiency_priority: prefs.tokenEfficiencyPriority,
        domains: prefs.domains,
      },
      feedbackHistory,
      requestId: ctx.requestId,
      userKey: userKeyFor(user.id),
    });
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    await fail(error instanceof ProviderError ? error.attempts : [], `${code}:${error instanceof ProviderError ? error.reason : "unknown"}`);
    log.warn("analysis failed", { code, analysis_id: analysis.id });
    throw new AppError(code, "The analysis service is temporarily unavailable. Please try again shortly.");
  }

  if (result.kind !== "ok") {
    await fail(result.attempts, result.kind === "refused" ? "ANALYSIS_REFUSED" : "INVALID_MODEL_OUTPUT");
    log.warn("analysis did not complete", { kind: result.kind, analysis_id: analysis.id });
    throw result.kind === "refused"
      ? new AppError("OPTIMISATION_REFUSED", "The reviewer declined to analyse this prompt.")
      : new AppError("INVALID_MODEL_OUTPUT", "The reviewer returned an unexpected result. Please try again.");
  }

  const usage = await recordAttempts(result.attempts);
  const output = result.output;
  const completed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(promptAnalyses)
      .set({
        status: "completed",
        qualityScore: output.overall_quality_score,
        alreadyOptimised: output.already_well_optimised,
        analysisResult: {
          summary: output.summary,
          recommended_actions: output.recommended_actions,
          score_note: "Heuristic indicator of clarity and completeness, not an objective quality measure.",
        },
        modelId: result.modelId,
        completedAt: new Date(),
        inputTokens: usage.total_input_tokens,
        outputTokens: usage.total_output_tokens,
        actualCost: usage.actual_cost === null ? null : usage.actual_cost.toFixed(10),
      })
      .where(eq(promptAnalyses.id, analysis.id))
      .returning();
    if (output.suggestions.length) {
      await tx.insert(promptSuggestions).values(
        output.suggestions.map((s, i) => ({
          userId: user.id,
          analysisId: analysis.id,
          promptId: prompt.id,
          promptVersionId: version.id,
          position: i + 1,
          category: s.category,
          priority: s.priority,
          title: s.title,
          explanation: s.explanation,
          recommendation: s.recommendation,
          estimatedTokenImpact: s.estimated_token_impact,
          tokenDirection: s.token_direction,
          requiresUserContext: s.requires_user_context,
          contextQuestion: s.context_question,
        })),
      );
    }
    await recordAnalysisUsage(tx, { userId: user.id, analysisId: analysis.id, inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, costUsd: usage.actual_cost ?? 0 });
    await refreshPromptStats(tx, prompt.id);
    return row ?? analysis;
  });

  log.info("analysis completed", { analysis_id: analysis.id, suggestions: output.suggestions.length, score: output.overall_quality_score });
  return { analysis: completed, suggestions: await loadSuggestions(db, analysis.id), reused: false };
}

/** Latest completed analysis for a prompt (any version), with its suggestions. */
export async function getLatestAnalysis(db: DbOrTx, userId: string, promptId: string): Promise<{ analysis: PromptAnalysis; suggestions: PromptSuggestion[] } | null> {
  const analysis = await db.query.promptAnalyses.findFirst({
    where: and(eq(promptAnalyses.promptId, promptId), eq(promptAnalyses.userId, userId), eq(promptAnalyses.status, "completed")),
    orderBy: [desc(promptAnalyses.createdAt)],
  });
  if (!analysis) return null;
  return { analysis, suggestions: await loadSuggestions(db, analysis.id) };
}

export interface ListSuggestionsOptions {
  promptId?: string;
  status?: SuggestionStatus[];
  page?: number;
  pageSize?: number;
}

/** The caller's suggestions, optionally for one prompt, newest analysis first. */
export async function listSuggestions(db: DbOrTx, userId: string, options: ListSuggestionsOptions = {}) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 50));
  const conditions = [eq(promptSuggestions.userId, userId)];
  if (options.promptId) conditions.push(eq(promptSuggestions.promptId, options.promptId));
  if (options.status?.length) conditions.push(inArray(promptSuggestions.status, options.status));
  const rows = await db
    .select({ s: promptSuggestions, title: prompts.title })
    .from(promptSuggestions)
    .innerJoin(prompts, eq(prompts.id, promptSuggestions.promptId))
    .where(and(...conditions))
    .orderBy(desc(promptSuggestions.createdAt), asc(promptSuggestions.position))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return rows.map((r) => ({ ...serialiseSuggestion(r.s), prompt_title: r.title }));
}

const USER_SETTABLE: SuggestionStatus[] = ["pending", "accepted", "dismissed", "deferred"];

/**
 * Accept, dismiss or defer a suggestion (or move it back to pending). "applied"
 * is set only when an optimised version that used it is saved.
 */
export async function setSuggestionStatus(db: DbOrTx, userId: string, suggestionId: string, status: SuggestionStatus): Promise<PromptSuggestion> {
  if (!USER_SETTABLE.includes(status)) throw new AppError("VALIDATION_ERROR", "Status must be pending, accepted, dismissed or deferred.");
  const existing = await db.query.promptSuggestions.findFirst({ where: and(eq(promptSuggestions.id, suggestionId), eq(promptSuggestions.userId, userId)) });
  if (!existing) throw notFound("Suggestion");
  if (existing.status === "applied") throw new AppError("CONFLICT", "This suggestion is already part of a saved version.");
  const [updated] = await db
    .update(promptSuggestions)
    .set({ status, feedbackAt: new Date() })
    .where(and(eq(promptSuggestions.id, suggestionId), eq(promptSuggestions.userId, userId)))
    .returning();
  if (!updated) throw notFound("Suggestion");
  await refreshPromptStats(db, existing.promptId);
  return updated;
}

/** Suggestions of this prompt owned by the caller, in the requested order. */
export async function getOwnedSuggestions(db: DbOrTx, userId: string, promptId: string, ids: string[]): Promise<PromptSuggestion[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.promptSuggestions.findMany({
    where: and(eq(promptSuggestions.userId, userId), eq(promptSuggestions.promptId, promptId), inArray(promptSuggestions.id, ids)),
  });
  if (rows.length !== new Set(ids).size) throw notFound("Suggestion");
  return ids.map((id) => rows.find((r) => r.id === id) as PromptSuggestion);
}

export function serialiseAnalysis(a: PromptAnalysis) {
  const result = a.analysisResult as { summary?: string; recommended_actions?: string[]; score_note?: string };
  return {
    id: a.id,
    prompt_id: a.promptId,
    prompt_version_id: a.promptVersionId,
    analysis_status: a.status,
    overall_quality_score: a.qualityScore,
    score_note: result.score_note ?? "Heuristic indicator, not an objective measure.",
    already_well_optimised: a.alreadyOptimised,
    summary: result.summary ?? null,
    recommended_actions: result.recommended_actions ?? [],
    target_model: a.targetModel,
    model_id: a.modelId,
    template_version: a.templateVersion,
    actual_usage: { input_tokens: a.inputTokens, output_tokens: a.outputTokens, actual_cost: a.actualCost === null ? null : Number(a.actualCost) },
    error_code: a.errorCode,
    created_at: a.createdAt.toISOString(),
    completed_at: a.completedAt?.toISOString() ?? null,
  };
}

export function serialiseSuggestion(s: PromptSuggestion) {
  return {
    id: s.id,
    analysis_id: s.analysisId,
    prompt_id: s.promptId,
    prompt_version_id: s.promptVersionId,
    category: s.category,
    category_label: SUGGESTION_CATEGORY_LABELS[s.category as SuggestionCategory] ?? s.category,
    priority: s.priority,
    title: s.title,
    explanation: s.explanation,
    recommendation: s.recommendation,
    estimated_token_impact: s.estimatedTokenImpact,
    token_direction: s.tokenDirection,
    requires_user_context: s.requiresUserContext,
    context_question: s.contextQuestion,
    status: s.status,
    applied_version_id: s.appliedVersionId,
    feedback_at: s.feedbackAt?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
  };
}

export type SerialisedSuggestion = ReturnType<typeof serialiseSuggestion>;
export type SerialisedAnalysis = ReturnType<typeof serialiseAnalysis>;

/** Mark suggestions as part of a saved version. */
export async function markSuggestionsApplied(db: DbOrTx, userId: string, promptId: string, ids: string[], versionId: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(promptSuggestions)
    .set({ status: "applied", appliedVersionId: versionId, feedbackAt: new Date() })
    .where(and(eq(promptSuggestions.userId, userId), eq(promptSuggestions.promptId, promptId), inArray(promptSuggestions.id, ids)))
    .returning({ id: promptSuggestions.id });
  return rows.length;
}
