import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import { RUBRIC_WEIGHTS } from "@/lib/config/intelligence";
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
import { isIntentCategory, SUGGESTION_KIND_LABELS, toSuggestionKind, type IntentCategory } from "@/lib/intelligence/categories";
import { analyseText, AttemptLog, EngineProviderError, type AnalysisResult } from "@/lib/intelligence/engine";
import { INTELLIGENCE_TEMPLATE_VERSION } from "@/lib/intelligence/instructions";
import type { RequestLogger } from "@/lib/logger";
import { userKeyFor } from "@/lib/optimiser/service";
import { ProviderError, type IntelligenceProvider, type ProviderAttempt } from "@/lib/providers/types";

import { recordApiUsage, summariseUsage } from "./estimates";
import { recordFeedbackEvent, STATUS_EVENT } from "./feedback-events";
import { getPromptPreferences, getRankingContext, preferencesForModel } from "./prompt-preferences";
import { getPrompt, refreshPromptStats } from "./prompts";
import { assertAnalysisQuotaAvailable, globalSpendTodayUsd, recordAnalysisUsage } from "./usage";

/** Identifies the rubric weights an analysis was scored with. */
export const RUBRIC_VERSION = `rubric-v1:${Object.values(RUBRIC_WEIGHTS).join("-")}`;

export interface AnalyseContext {
  db: Db;
  user: AppUser;
  provider: IntelligenceProvider;
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
  /** The user's manual task category. */
  category?: IntentCategory | null;
}

export interface AnalysisWithSuggestions {
  analysis: PromptAnalysis;
  suggestions: PromptSuggestion[];
  /** True when an existing analysis of the same version was returned (no new AI call). */
  reused: boolean;
  /** Full engine output when this call ran the analysis (not stored verbatim). */
  engine?: AnalysisResult;
}

async function loadSuggestions(db: DbOrTx, analysisId: string): Promise<PromptSuggestion[]> {
  return db.query.promptSuggestions.findMany({ where: eq(promptSuggestions.analysisId, analysisId), orderBy: [asc(promptSuggestions.position)] });
}

/** Map engine/provider failures to safe API errors. */
export function providerFailure(error: unknown): { code: string; attempts: ProviderAttempt[]; appError: AppError } {
  if (error instanceof ProviderError) {
    return { code: `${error.code}:${error.reason}`, attempts: error.attempts, appError: new AppError(error.code, "The AI service is temporarily unavailable. Nothing was changed — please try again shortly.", error.retryAfterSeconds ? { headers: { "Retry-After": String(error.retryAfterSeconds) } } : {}) };
  }
  if (error instanceof EngineProviderError) {
    return {
      code: error.kind === "refused" ? "ANALYSIS_REFUSED" : "INVALID_MODEL_OUTPUT",
      attempts: error.attempts,
      appError: error.kind === "refused" ? new AppError("OPTIMISATION_REFUSED", "The model declined to process this prompt. Nothing was changed.") : new AppError("INVALID_MODEL_OUTPUT", "The model returned an unexpected result. Please try again."),
    };
  }
  throw error;
}

/**
 * Analyse one saved prompt version with the Prompt Intelligence Engine and
 * store the result linked to that exact version. Only that version's text is
 * sent to the provider. Re-analysing an unchanged version reuses the stored
 * result unless `force` is set or the user changes the category.
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
  const categoryChanged = Boolean(input.category && existing && existing.taskCategory !== input.category);
  if (existing && !input.force && !categoryChanged) {
    return { analysis: existing, suggestions: await loadSuggestions(db, existing.id), reused: true };
  }

  if (version.promptText.length > planFor(user.planCode).maxPromptChars) {
    throw new AppError("PROMPT_TOO_LONG", "This prompt is longer than your plan allows for analysis.");
  }
  await assertAnalysisQuotaAvailable(db, user);
  if (ctx.globalDailySpendCapUsd > 0 && (await globalSpendTodayUsd(db)) >= ctx.globalDailySpendCapUsd) {
    throw new AppError("SPEND_CAP_REACHED", "Analysis is temporarily paused. Please try again later.");
  }

  const prefs = await getPromptPreferences(db, user.id);
  const targetModel = prompt.targetModel ?? prefs.preferredModel ?? DEFAULT_TARGET_MODEL;
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
        templateVersion: INTELLIGENCE_TEMPLATE_VERSION,
        rubricVersion: RUBRIC_VERSION,
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

  const ranking = await getRankingContext(db, user.id, input.category ?? null);
  const attemptLog = new AttemptLog();
  let result: AnalysisResult;
  try {
    result = await analyseText({
      text: version.promptText,
      categoryOverride: input.category ?? null,
      targetModel,
      provider,
      ranking,
      preferences: preferencesForModel(prefs),
      requestId: ctx.requestId,
      userKey: userKeyFor(user.id),
      versionKey: version.id,
      log: attemptLog,
    });
  } catch (error) {
    const failure = providerFailure(error);
    const usage = await recordAttempts(failure.attempts.length ? failure.attempts : attemptLog.attempts);
    await db
      .update(promptAnalyses)
      .set({ status: "failed", errorCode: failure.code, completedAt: new Date(), inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, actualCost: usage.actual_cost === null ? null : usage.actual_cost.toFixed(10) })
      .where(eq(promptAnalyses.id, analysis.id));
    log.warn("analysis failed", { code: failure.code, analysis_id: analysis.id });
    throw failure.appError;
  }

  const usage = await recordAttempts(result.attempts);
  const c = result.classification;
  const completed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(promptAnalyses)
      .set({
        status: "completed",
        qualityScore: result.score.overall,
        alreadyOptimised: result.already_well_optimised,
        analysisResult: {
          summary: summarise(result),
          objective: c.objective,
          explanation: result.score.explanation,
          priorities: result.score.priorities,
          missing_elements: result.score.missing_elements,
          sufficiently_clear: result.score.sufficiently_clear,
          needs_more_context: result.score.needs_more_context,
          template: result.template,
          score_note: result.score.note,
          recommended_actions: result.suggestions.slice(0, 3).map((s) => s.title),
        },
        taskCategory: c.primary,
        secondaryCategory: c.secondary,
        classificationConfidence: c.confidence.toFixed(3),
        classificationMethod: c.method,
        dimensionScores: result.score.dimensions,
        missingInformation: c.missing_information,
        requirementChecklist: result.requirements.map((r) => ({ id: r.id, kind: r.kind, start: r.start, end: r.end, essential: r.essential })),
        modelUsed: result.model_used,
        modelId: result.attempts[result.attempts.length - 1]?.modelId ?? provider.modelId,
        completedAt: new Date(),
        inputTokens: usage.total_input_tokens,
        outputTokens: usage.total_output_tokens,
        actualCost: usage.actual_cost === null ? null : usage.actual_cost.toFixed(10),
      })
      .where(eq(promptAnalyses.id, analysis.id))
      .returning();
    if (result.suggestions.length) {
      await tx.insert(promptSuggestions).values(
        result.suggestions.map((s, i) => ({
          userId: user.id,
          analysisId: analysis.id,
          promptId: prompt.id,
          promptVersionId: version.id,
          position: i + 1,
          category: s.category,
          priority: s.priority,
          title: s.title,
          explanation: s.explanation,
          recommendation: s.recommended_change,
          expectedBenefit: s.expected_benefit,
          tokenImpact: s.estimated_token_impact,
          estimatedTokenImpact: impactBucket(s.estimated_token_impact, s.token_direction),
          tokenDirection: s.token_direction,
          requiresUserContext: s.requires_clarification,
          contextQuestion: s.clarification_question,
          source: s.source,
          recommendationScore: s.ranking.score.toFixed(3),
          ranking: { ...s.ranking },
        })),
      );
    }
    await recordAnalysisUsage(tx, { userId: user.id, analysisId: analysis.id, inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, costUsd: usage.actual_cost ?? 0 });
    await refreshPromptStats(tx, prompt.id);
    return row ?? analysis;
  });

  log.info("analysis completed", { analysis_id: analysis.id, suggestions: result.suggestions.length, score: result.score.overall, category: c.primary, model_used: result.model_used });
  return { analysis: completed, suggestions: await loadSuggestions(db, analysis.id), reused: false, engine: result };
}

export function summarise(result: AnalysisResult): string {
  if (result.already_well_optimised) return "Already well optimised: the goal, requirements and expected output are clear. No changes needed.";
  const n = result.suggestions.length;
  return `${n} improvement${n === 1 ? "" : "s"} suggested. ${result.score.explanation}`;
}

function impactBucket(tokens: number | null, direction: string): "none" | "low" | "medium" | "high" {
  if (tokens === null) return direction === "neutral" ? "none" : "low";
  const t = Math.abs(tokens);
  return t === 0 ? "none" : t < 10 ? "low" : t < 40 ? "medium" : "high";
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
  const eventType = STATUS_EVENT[status];
  if (eventType && existing.status !== status) {
    const analysis = await db.query.promptAnalyses.findFirst({ where: eq(promptAnalyses.id, existing.analysisId), columns: { taskCategory: true } });
    await recordFeedbackEvent(db, { userId, eventType, promptId: existing.promptId, promptVersionId: existing.promptVersionId, suggestionId: existing.id, suggestionCategory: toSuggestionKind(existing.category), taskCategory: analysis?.taskCategory ?? null });
  }
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

export function serialiseAnalysis(a: PromptAnalysis, opts: { versionText?: string; currentVersionId?: string | null } = {}) {
  const result = a.analysisResult as {
    summary?: string;
    recommended_actions?: string[];
    score_note?: string;
    objective?: string;
    explanation?: string;
    priorities?: unknown[];
    missing_elements?: string[];
    sufficiently_clear?: boolean;
    needs_more_context?: boolean;
    template?: { id: string; label: string; version: number };
  };
  const checklist = (a.requirementChecklist ?? []) as Array<{ id: string; kind: string; start: number; end: number; essential: boolean }>;
  const task = a.taskCategory && isIntentCategory(a.taskCategory) ? a.taskCategory : null;
  return {
    id: a.id,
    prompt_id: a.promptId,
    prompt_version_id: a.promptVersionId,
    /** False once the prompt has a newer version: the analysis is historical. */
    is_current: opts.currentVersionId === undefined ? null : opts.currentVersionId === a.promptVersionId,
    analysis_status: a.status,
    overall_quality_score: a.qualityScore,
    score_note: result.score_note ?? "Heuristic indicator, not an objective measure.",
    already_well_optimised: a.alreadyOptimised,
    summary: result.summary ?? null,
    recommended_actions: result.recommended_actions ?? [],
    classification: task
      ? {
          primary: task,
          secondary: a.secondaryCategory,
          objective: result.objective ?? null,
          confidence: a.classificationConfidence === null ? null : Number(a.classificationConfidence),
          method: a.classificationMethod,
          template: result.template ?? null,
        }
      : null,
    score: {
      overall: a.qualityScore,
      dimensions: a.dimensionScores ?? [],
      priorities: result.priorities ?? [],
      missing_elements: result.missing_elements ?? [],
      sufficiently_clear: result.sufficiently_clear ?? null,
      needs_more_context: result.needs_more_context ?? null,
      explanation: result.explanation ?? null,
    },
    missing_information: a.missingInformation ?? [],
    requirements: opts.versionText
      ? checklist.map((r) => ({ id: r.id, kind: r.kind, essential: r.essential, text: opts.versionText!.slice(r.start, r.end) }))
      : checklist.map((r) => ({ id: r.id, kind: r.kind, essential: r.essential, text: null })),
    rubric_version: a.rubricVersion,
    model_used: a.modelUsed,
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
  const kind = toSuggestionKind(s.category);
  return {
    id: s.id,
    analysis_id: s.analysisId,
    prompt_id: s.promptId,
    prompt_version_id: s.promptVersionId,
    category: kind,
    category_label: SUGGESTION_KIND_LABELS[kind],
    priority: s.priority,
    title: s.title,
    explanation: s.explanation,
    recommendation: s.recommendation,
    recommended_change: s.recommendation,
    expected_benefit: s.expectedBenefit,
    estimated_token_impact: s.estimatedTokenImpact,
    token_impact: s.tokenImpact,
    token_direction: s.tokenDirection,
    requires_user_context: s.requiresUserContext,
    requires_clarification: s.requiresUserContext,
    context_question: s.contextQuestion,
    clarification_question: s.contextQuestion,
    source: s.source,
    recommendation_score: s.recommendationScore === null ? null : Number(s.recommendationScore),
    ranking: s.ranking,
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
