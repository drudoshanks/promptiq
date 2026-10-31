import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import { INTELLIGENCE_CONFIG } from "@/lib/config/intelligence";
import { DEFAULT_TARGET_MODEL, isSupportedModel } from "@/lib/config/models";
import { HARD_MAX_PROMPT_CHARS, planFor } from "@/lib/config/plans";
import { optimisationRuns, promptSuggestions, type AppUser, type PromptSuggestion } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { INTENT_LABELS, SUGGESTION_KIND_LABELS, TO_TASK_CATEGORY, toSuggestionKind, type GenerationMode, type IntentCategory } from "@/lib/intelligence/categories";
import type { Classification } from "@/lib/intelligence/classifier";
import { analyseText, quickClassification, reviseText, type AnalysisResult, type RevisionResult } from "@/lib/intelligence/engine";
import { INTELLIGENCE_TEMPLATE_VERSION } from "@/lib/intelligence/instructions";
import { compactReport, REQUIREMENT_KIND_LABELS, validatePreservation, type PreservationReport } from "@/lib/intelligence/requirements";
import type { RequestLogger } from "@/lib/logger";
import { normalisePrompt } from "@/lib/optimiser/normalise";
import { userKeyFor } from "@/lib/optimiser/service";
import type { IntelligenceProvider, ProviderAttempt } from "@/lib/providers/types";

import { analysePrompt, getLatestAnalysis, getOwnedSuggestions, providerFailure, serialiseAnalysis, serialiseSuggestion, summarise } from "./analysis";
import { compareTexts, estimateText, recordApiUsage, recordTokenEstimate, summariseUsage, type TokenComparisonResult } from "./estimates";
import { recordFeedbackEvent, recordFeedbackEvents } from "./feedback-events";
import { getPromptPreferences, getRankingContext, preferencesForModel } from "./prompt-preferences";
import { getPrompt } from "./prompts";
import { assertAnalysisQuotaAvailable, assertQuotaAvailable, finaliseRun, globalSpendTodayUsd, recordAnalysisUsage, recordRun, recordRunComparison, recordUsage } from "./usage";

/**
 * Prompt Intelligence service: ownership, quotas, persistence and usage
 * accounting around the storage-free engine in @/lib/intelligence.
 */
export interface IntelligenceContext {
  db: Db;
  user: AppUser;
  provider: IntelligenceProvider;
  requestId: string;
  log: RequestLogger;
  globalDailySpendCapUsd: number;
}

type Source = { text: string; promptId?: undefined } | { promptId: string; versionId?: string | null; text?: string | null };

interface ResolvedSource {
  text: string;
  promptId: string | null;
  versionId: string | null;
  currentVersionId: string | null;
  targetModel: string | null;
}

async function resolveSource(ctx: IntelligenceContext, source: Source): Promise<ResolvedSource> {
  const plan = planFor(ctx.user.planCode);
  let resolved: ResolvedSource;
  if (source.promptId) {
    const prompt = await getPrompt(ctx.db, ctx.user.id, source.promptId);
    const version = source.versionId ? prompt.versions.find((v) => v.id === source.versionId) : prompt.versions[prompt.versions.length - 1];
    if (!version) throw notFound("Version");
    // An edited draft of a saved prompt is analysed as text but stays linked to its prompt.
    const text = source.text?.trim() ? source.text : version.promptText;
    resolved = { text, promptId: prompt.id, versionId: version.id, currentVersionId: prompt.currentVersionId, targetModel: prompt.targetModel };
  } else {
    resolved = { text: source.text ?? "", promptId: null, versionId: null, currentVersionId: null, targetModel: null };
  }
  resolved.text = normalisePrompt(resolved.text);
  if (!resolved.text) throw new AppError("PROMPT_EMPTY", "Enter a prompt first.");
  if (resolved.text.length > Math.min(plan.maxPromptChars, HARD_MAX_PROMPT_CHARS)) {
    throw new AppError("PROMPT_TOO_LONG", `Prompts on the ${plan.name} plan can be up to ${plan.maxPromptChars.toLocaleString("en")} characters.`, { details: { limit: plan.maxPromptChars, length: resolved.text.length } });
  }
  return resolved;
}

function resolveModel(requested: string | null | undefined, fallback: string | null): string {
  const model = requested ?? fallback ?? DEFAULT_TARGET_MODEL;
  if (!isSupportedModel(model)) throw new AppError("UNSUPPORTED_MODEL", `Token counts are not available for model "${model}". Choose a supported model.`);
  return model;
}

async function assertSpendCap(ctx: IntelligenceContext) {
  if (ctx.globalDailySpendCapUsd > 0 && (await globalSpendTodayUsd(ctx.db)) >= ctx.globalDailySpendCapUsd) {
    throw new AppError("SPEND_CAP_REACHED", "AI features are temporarily paused. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
export interface AnalyseIntelligenceInput {
  source: Source;
  category?: IntentCategory | null;
  targetModel?: string | null;
  force?: boolean;
}

/** Unsaved text results are cached briefly so re-clicking Analyse is free. Keyed by a hash, never the text. */
const adhocCache = new Map<string, { expiresAt: number; result: AnalysisResult }>();

function cacheKey(userId: string, text: string, model: string, category: string | null) {
  return createHash("sha256").update(`${userId}\u0000${model}\u0000${category ?? ""}\u0000${INTELLIGENCE_TEMPLATE_VERSION}\u0000${text}`).digest("hex");
}

export async function analyseForUser(ctx: IntelligenceContext, input: AnalyseIntelligenceInput) {
  const { db, user } = ctx;
  const src = await resolveSource(ctx, input.source);
  const prefs = await getPromptPreferences(db, user.id);
  const targetModel = resolveModel(input.targetModel, src.targetModel ?? prefs.preferredModel);
  const tokens = await estimateText(db, { text: src.text, modelId: targetModel });

  // A saved version (not an edited draft): stored, version-linked analysis.
  const isSavedVersion = src.promptId && src.versionId && (!("text" in input.source) || !input.source.text?.trim());
  if (isSavedVersion) {
    const stored = await analysePrompt(ctx, { promptId: src.promptId!, versionId: src.versionId, force: input.force, category: input.category ?? null });
    const prompt = await getPrompt(db, user.id, src.promptId!);
    const version = prompt.versions.find((v) => v.id === stored.analysis.promptVersionId);
    return presentStored(stored, version?.promptText ?? src.text, prompt.currentVersionId, tokens, stored.engine ?? null);
  }

  const key = cacheKey(user.id, src.text, targetModel, input.category ?? null);
  const cached = adhocCache.get(key);
  let result: AnalysisResult;
  let reused = false;
  if (cached && cached.expiresAt > Date.now() && !input.force) {
    result = cached.result;
    reused = true;
  } else {
    await assertAnalysisQuotaAvailable(db, user);
    await assertSpendCap(ctx);
    const ranking = await getRankingContext(db, user.id, input.category ?? null);
    try {
      result = await analyseText({ text: src.text, categoryOverride: input.category ?? null, targetModel, provider: ctx.provider, ranking, preferences: preferencesForModel(prefs), requestId: ctx.requestId, userKey: userKeyFor(user.id), versionKey: key.slice(0, 16) });
    } catch (error) {
      const failure = providerFailure(error);
      await recordAdhocUsage(ctx, randomUUID(), failure.attempts, "prompt_analysis");
      throw failure.appError;
    }
    const analysisId = randomUUID();
    const usage = await recordAdhocUsage(ctx, analysisId, result.attempts, "prompt_analysis");
    if (result.attempts.length) {
      await recordAnalysisUsage(db, { userId: user.id, analysisId, inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, costUsd: usage.actual_cost ?? 0 });
    }
    adhocCache.set(key, { expiresAt: Date.now() + INTELLIGENCE_CONFIG.adhocCacheMs, result });
    if (adhocCache.size > 2000) for (const [k, v] of adhocCache) if (v.expiresAt <= Date.now()) adhocCache.delete(k);
  }
  return presentFresh(result, src, tokens, reused);
}

async function recordAdhocUsage(ctx: IntelligenceContext, operationId: string, attempts: ProviderAttempt[], requestType: string) {
  const rows = [];
  for (const a of attempts) {
    const r = await recordApiUsage(ctx.db, {
      userId: ctx.user.id,
      runId: null,
      operationId,
      attempt: a.attempt,
      provider: ctx.provider.name,
      modelId: a.modelId,
      requestType,
      providerRequestId: a.providerRequestId ?? null,
      status: a.status,
      inputTokens: a.usage?.inputTokens ?? 0,
      outputTokens: a.usage?.outputTokens ?? 0,
      cachedInputTokens: a.usage?.cachedInputTokens ?? null,
      usageReported: a.usage !== null,
    });
    if (r) rows.push(r.record);
  }
  return summariseUsage(rows);
}

function presentClassification(c: Classification, template: { id: string; label: string; version: number }) {
  return {
    primary: c.primary,
    primary_label: INTENT_LABELS[c.primary],
    secondary: c.secondary,
    secondary_label: c.secondary ? INTENT_LABELS[c.secondary] : null,
    objective: c.objective,
    confidence: c.confidence,
    method: c.method,
    template,
  };
}

function presentFresh(result: AnalysisResult, src: ResolvedSource, tokens: Awaited<ReturnType<typeof estimateText>>, reused: boolean) {
  return {
    analysis_id: null as string | null,
    prompt_id: src.promptId,
    prompt_version_id: src.versionId,
    is_current: src.versionId ? src.versionId === src.currentVersionId : null,
    stored: false,
    reused,
    classification: presentClassification(result.classification, result.template),
    score: result.score,
    missing_information: result.classification.missing_information,
    clarification_questions: result.clarification_questions,
    assumptions: result.assumptions,
    requirements: result.requirements.map((r) => ({ id: r.id, kind: r.kind, kind_label: REQUIREMENT_KIND_LABELS[r.kind], text: r.text, essential: r.essential })),
    model_requirements: result.model_requirements,
    intent: result.intent,
    suggestions: result.suggestions.map((s) => ({ ...s, status: "pending" as const, persisted: false })),
    already_well_optimised: result.already_well_optimised,
    summary: summarise(result),
    token_estimate: tokens,
    model_used: result.model_used,
    template_version: result.template_version,
  };
}

function presentStored(
  stored: { analysis: Parameters<typeof serialiseAnalysis>[0]; suggestions: PromptSuggestion[]; reused: boolean },
  versionText: string,
  currentVersionId: string | null,
  tokens: Awaited<ReturnType<typeof estimateText>>,
  engine: AnalysisResult | null,
) {
  const a = serialiseAnalysis(stored.analysis, { versionText, currentVersionId });
  // Classification and IR are recomputed deterministically from the stored version and stored category.
  const c = quickClassification(versionText, (a.classification?.primary ?? null) as IntentCategory | null);
  const fresh = engine;
  const classification = fresh?.classification ?? { ...c, method: (a.classification?.method ?? c.method) as Classification["method"], confidence: a.classification?.confidence ?? c.confidence, secondary: (a.classification?.secondary ?? c.secondary) as IntentCategory | null };
  const template = a.classification?.template ?? { id: c.template_id, label: c.template_id, version: 1 };
  const missing = (a.missing_information as Classification["missing_information"]) ?? [];
  return {
    analysis_id: a.id,
    prompt_id: a.prompt_id,
    prompt_version_id: a.prompt_version_id,
    is_current: a.is_current,
    stored: true,
    reused: stored.reused,
    classification: presentClassification({ ...classification, missing_information: missing }, template),
    score: { ...(a.score as object), overall: a.overall_quality_score, note: a.score_note } as AnalysisResult["score"],
    missing_information: missing,
    clarification_questions: missing,
    assumptions: fresh?.assumptions ?? missing.map((m) => `${m.label}: not specified. If it matters, ask before choosing; otherwise state the choice you make.`),
    requirements: a.requirements.map((r) => ({ ...r, kind_label: REQUIREMENT_KIND_LABELS[r.kind as keyof typeof REQUIREMENT_KIND_LABELS] ?? r.kind })),
    model_requirements: fresh?.model_requirements ?? [],
    intent: fresh?.intent ?? null,
    suggestions: stored.suggestions.map((s) => ({ ...serialiseSuggestion(s), persisted: true })),
    already_well_optimised: a.already_well_optimised,
    summary: a.summary,
    token_estimate: tokens,
    model_used: a.model_used,
    template_version: a.template_version,
  };
}

export type IntelligenceAnalysis = Awaited<ReturnType<typeof analyseForUser>>;

// ---------------------------------------------------------------------------
// Generation / optimisation
// ---------------------------------------------------------------------------
export interface ReviseInput {
  source: Source;
  mode: GenerationMode;
  category?: IntentCategory | null;
  targetModel?: string | null;
  tokenBudget?: number | null;
  assumptions?: string[] | null;
  answers?: Record<string, string> | null;
  /** Persisted suggestions of a saved prompt to apply (marked accepted). */
  suggestionIds?: string[];
  /** Recommendations of unsaved-analysis suggestions the user accepted. */
  acceptedChanges?: Array<{ category: string; text: string }>;
  customObjective?: string | null;
}

export async function reviseForUser(ctx: IntelligenceContext, input: ReviseInput) {
  const { db, user, provider, log } = ctx;
  const startedAt = Date.now();
  const src = await resolveSource(ctx, input.source);
  const prefs = await getPromptPreferences(db, user.id);
  const targetModel = resolveModel(input.targetModel, src.targetModel ?? prefs.preferredModel);
  if (input.mode === "custom" && !input.customObjective?.trim()) throw new AppError("VALIDATION_ERROR", "Describe your objective for custom optimisation.");

  // Suggestions to apply: persisted (saved prompt) or ephemeral (unsaved text).
  let persisted: PromptSuggestion[] = [];
  if (input.suggestionIds?.length) {
    if (!src.promptId) throw new AppError("VALIDATION_ERROR", "Saved suggestions can only be applied to their own prompt.");
    persisted = await getOwnedSuggestions(db, user.id, src.promptId, [...new Set(input.suggestionIds)]);
    if (persisted.some((s) => s.status === "applied" || s.status === "dismissed")) throw new AppError("CONFLICT", "Only pending, deferred or accepted suggestions can be applied.");
  }
  const acceptedChanges = [...persisted.map((s) => s.recommendation), ...(input.acceptedChanges ?? []).map((c) => c.text.trim()).filter(Boolean)].slice(0, 12);
  const acceptedKinds = [...new Set([...persisted.map((s) => toSuggestionKind(s.category)), ...(input.acceptedChanges ?? []).map((c) => toSuggestionKind(c.category))])];

  await assertQuotaAvailable(db, user);
  await assertSpendCap(ctx);

  const classification = quickClassification(src.text, input.category ?? null);
  const run = await recordRun(db, {
    userId: user.id,
    provider: provider.name,
    modelId: provider.modelId,
    templateVersion: INTELLIGENCE_TEMPLATE_VERSION,
    taskCategory: TO_TASK_CATEGORY[classification.primary],
    status: "queued",
    inputChars: src.text.length,
    latencyMs: 0,
    requestId: ctx.requestId,
    promptId: src.promptId,
    sourceVersionId: src.versionId,
  });

  const recordAttempts = async (attempts: ProviderAttempt[]) => {
    const rows = [];
    let pricingVersion: string | null = null;
    for (const a of attempts) {
      const r = await recordApiUsage(db, {
        userId: user.id,
        runId: run.id,
        attempt: a.attempt,
        provider: provider.name,
        modelId: a.modelId,
        requestType: "prompt_revision",
        providerRequestId: a.providerRequestId ?? null,
        status: a.status,
        inputTokens: a.usage?.inputTokens ?? 0,
        outputTokens: a.usage?.outputTokens ?? 0,
        cachedInputTokens: a.usage?.cachedInputTokens ?? null,
        usageReported: a.usage !== null,
      });
      if (r) {
        rows.push(r.record);
        pricingVersion ??= r.record.pricingVersion;
      }
    }
    return { summary: summariseUsage(rows), pricingVersion };
  };

  let result: RevisionResult;
  try {
    result = await reviseText({
      text: src.text,
      mode: input.mode,
      classification,
      assumptions: input.assumptions ?? null,
      answers: input.answers ?? null,
      acceptedChanges,
      acceptedKinds,
      customObjective: input.customObjective ?? null,
      tokenBudget: input.tokenBudget ?? null,
      targetModel,
      provider,
      preferences: preferencesForModel(prefs),
      requestId: ctx.requestId,
      userKey: userKeyFor(user.id),
    });
  } catch (error) {
    const failure = providerFailure(error);
    const usage = await recordAttempts(failure.attempts);
    await finaliseRun(db, run.id, { status: "failed", modelId: provider.modelId, inputTokens: usage.summary.total_input_tokens, outputTokens: usage.summary.total_output_tokens, cachedInputTokens: null, costUsd: usage.summary.actual_cost, pricingVersion: usage.pricingVersion, attemptCount: Math.max(1, failure.attempts.length), latencyMs: Date.now() - startedAt, errorCode: failure.code });
    log.warn("revision failed", { code: failure.code, run_id: run.id });
    throw failure.appError;
  }

  const usage = await recordAttempts(result.attempts);
  await finaliseRun(db, run.id, {
    status: "succeeded",
    modelId: result.engine === "local" ? "promptiq-rules" : (result.attempts[result.attempts.length - 1]?.modelId ?? provider.modelId),
    outputChars: result.revised_prompt.length,
    inputTokens: result.attempts.length ? usage.summary.total_input_tokens : 0,
    outputTokens: result.attempts.length ? usage.summary.total_output_tokens : 0,
    cachedInputTokens: null,
    costUsd: result.attempts.length ? usage.summary.actual_cost : 0,
    pricingVersion: usage.pricingVersion,
    attemptCount: Math.max(1, result.attempts.length),
    latencyMs: Date.now() - startedAt,
  });

  // Exact counts of original and revised text for the target model (TokenEstimator + CostEstimator).
  const estimate = await compareTexts(db, { original: src.text, optimised: result.revised_prompt, modelId: targetModel, expectedOutput: prefs.preferredResponseLength ?? undefined });
  await recordRunComparison(db, run.id, {
    mode: input.mode,
    targetModel: estimate.model,
    tokensSaved: estimate.tokens_saved,
    reductionPercent: estimate.reduction_percent,
    inputCostBefore: estimate.cost?.input_cost_before ?? null,
    inputCostAfter: estimate.cost?.input_cost_after ?? null,
    appliedSuggestionCount: acceptedChanges.length,
  });
  await db
    .update(optimisationRuns)
    .set({
      intentCategory: classification.primary,
      tokenBudget: result.budget.requested,
      preservationStatus: result.report.status,
      preservationReport: compactReport(result.report),
      iterations: result.iterations,
      engine: result.engine,
    })
    .where(eq(optimisationRuns.id, run.id));
  await persistEstimates(db, user.id, run.id, src.versionId, estimate);

  // Quota: one unit per logical operation that used the model; local-only revisions are free.
  if (result.attempts.length) {
    await recordUsage(db, { userId: user.id, runId: run.id, idempotencyKey: null, inputTokens: usage.summary.total_input_tokens, outputTokens: usage.summary.total_output_tokens, costUsd: usage.summary.actual_cost ?? 0 });
  }

  // Explicit feedback: chosen mode, accepted suggestions.
  if (persisted.length) {
    await db.update(promptSuggestions).set({ status: "accepted", feedbackAt: new Date() }).where(and(eq(promptSuggestions.userId, user.id), inArray(promptSuggestions.id, persisted.map((s) => s.id))));
  }
  await recordFeedbackEvents(db, [
    { userId: user.id, eventType: "mode_selected", promptId: src.promptId, promptVersionId: src.versionId, runId: run.id, optimisationMode: input.mode, taskCategory: classification.primary },
    ...persisted.filter((s) => s.status !== "accepted").map((s) => ({ userId: user.id, eventType: "suggestion_accepted" as const, promptId: src.promptId, promptVersionId: src.versionId, suggestionId: s.id, runId: run.id, suggestionCategory: toSuggestionKind(s.category), taskCategory: classification.primary })),
    ...(input.acceptedChanges ?? []).map((c) => ({ userId: user.id, eventType: "suggestion_accepted" as const, runId: run.id, suggestionCategory: toSuggestionKind(c.category), taskCategory: classification.primary })),
  ]);

  log.info("revision completed", { run_id: run.id, mode: input.mode, engine: result.engine, iterations: result.iterations, preservation: result.report.status, tokens_saved: estimate.tokens_saved });
  return presentRevision(run.id, src, input.mode, classification, result, estimate, usage.summary, persisted.map((s) => s.id));
}

async function persistEstimates(db: Db, userId: string, runId: string, versionId: string | null, estimate: TokenComparisonResult) {
  for (const side of ["original", "optimised"] as const) {
    await recordTokenEstimate(db, {
      userId,
      label: side,
      runId,
      promptVersionId: side === "original" ? versionId : null,
      estimate: {
        ...estimate[side],
        cost: estimate.cost
          ? {
              expected_output_tokens: estimate.cost.expected_output_tokens,
              expected_output_preset: estimate.cost.expected_output_preset,
              input_cost: side === "original" ? estimate.cost.input_cost_before : estimate.cost.input_cost_after,
              output_cost: estimate.cost.output_cost,
              total_cost: side === "original" ? estimate.cost.total_cost_before : estimate.cost.total_cost_after,
              currency: estimate.cost.currency,
              pricing_version: estimate.cost.pricing_version,
              pricing_status: estimate.cost.pricing_status,
              pricing_verified_at: estimate.cost.pricing_verified_at,
              calculated_at: estimate.cost.calculated_at,
            }
          : null,
        pricing_warning: estimate.pricing_warning,
        limitations: estimate.limitations,
      },
    });
  }
}

export function presentReport(report: PreservationReport) {
  return {
    ...report,
    checks: report.checks.map((c) => ({ id: c.id, kind: c.kind, kind_label: REQUIREMENT_KIND_LABELS[c.kind], text: c.text, essential: c.essential, status: c.status, method: c.method, note: c.note })),
  };
}

function presentRevision(
  runId: string,
  src: ResolvedSource,
  mode: GenerationMode,
  classification: Classification,
  result: RevisionResult,
  estimate: TokenComparisonResult,
  usage: ReturnType<typeof summariseUsage>,
  suggestionIds: string[],
) {
  return {
    revision_id: runId,
    optimisation_id: runId,
    prompt_id: src.promptId,
    source_version_id: src.versionId,
    mode,
    engine: result.engine,
    category: classification.primary,
    category_label: INTENT_LABELS[classification.primary],
    template: { id: result.template.id, label: result.template.label, version: result.template.version },
    original_prompt: src.text,
    revised_prompt: result.revised_prompt,
    intent: result.intent,
    preservation: presentReport(result.report),
    key_improvements: result.key_improvements,
    assumptions_introduced: result.assumptions_introduced,
    clarification_questions: result.clarification_questions,
    iterations: result.iterations,
    repaired: result.repaired,
    compression_steps: result.compression_steps,
    budget: result.budget,
    estimate,
    actual_usage: usage,
    suggestion_ids: suggestionIds,
    template_version: result.template_version,
  };
}

export type IntelligenceRevision = Awaited<ReturnType<typeof reviseForUser>>;

// ---------------------------------------------------------------------------
// Validation of an edited result
// ---------------------------------------------------------------------------
export async function validateForUser(ctx: IntelligenceContext, input: { original: string; revised: string; targetModel?: string | null; semantic?: boolean }) {
  const plan = planFor(ctx.user.planCode);
  const original = normalisePrompt(input.original);
  const revised = normalisePrompt(input.revised);
  if (!original || !revised) throw new AppError("PROMPT_EMPTY", "Both the original and the revised prompt are needed.");
  const max = Math.min(plan.maxPromptChars * 3, HARD_MAX_PROMPT_CHARS);
  if (original.length > max || revised.length > max) throw new AppError("PROMPT_TOO_LONG", "One of the prompts is longer than your plan allows.");
  const targetModel = resolveModel(input.targetModel, null);

  let semantic = null;
  const attempts: ProviderAttempt[] = [];
  if (input.semantic && ctx.provider.name === "openai") {
    await assertAnalysisQuotaAvailable(ctx.db, ctx.user);
    semantic = async (items: Array<{ id: string; text: string }>, text: string) => {
      const r = await ctx.provider.compareRequirements({ items, revised: text, requestId: ctx.requestId, userKey: userKeyFor(ctx.user.id) });
      attempts.push(...r.attempts);
      return r.kind === "ok" ? r.output.items : [];
    };
  }
  const report = await validatePreservation(original, revised, { semantic });
  if (attempts.length) {
    const id = randomUUID();
    const usage = await recordAdhocUsage(ctx, id, attempts.map((a, i) => ({ ...a, attempt: i + 1 })), "requirement_validation");
    await recordAnalysisUsage(ctx.db, { userId: ctx.user.id, analysisId: id, inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, costUsd: usage.actual_cost ?? 0 });
  }
  const estimate = await compareTexts(ctx.db, { original, optimised: revised, modelId: targetModel });
  return { preservation: presentReport(report), estimate, semantic_checked: attempts.length > 0 };
}

/** Record that a revision was saved as a version (called by the versions route). */
export async function recordRevisionSaved(db: Db, userId: string, input: { promptId: string; versionId: string; runId: string | null }) {
  let mode: string | null = null;
  let task: string | null = null;
  if (input.runId) {
    const run = await db.query.optimisationRuns.findFirst({ where: and(eq(optimisationRuns.id, input.runId), eq(optimisationRuns.userId, userId)), columns: { optimisationMode: true, intentCategory: true } });
    mode = run?.optimisationMode ?? null;
    task = run?.intentCategory ?? null;
  }
  await recordFeedbackEvent(db, { userId, eventType: "revision_saved", promptId: input.promptId, promptVersionId: input.versionId, runId: input.runId, optimisationMode: mode, taskCategory: task });
}

export const SUGGESTION_LABELS = SUGGESTION_KIND_LABELS;

/** The stored analysis of a prompt's current version, presented like a fresh one. No model call. */
export async function getStoredAnalysisView(db: Db, userId: string, promptId: string, targetModel: string): Promise<IntelligenceAnalysis | null> {
  const prompt = await getPrompt(db, userId, promptId);
  const current = prompt.versions[prompt.versions.length - 1];
  if (!current) return null;
  const latest = await getLatestAnalysis(db, userId, promptId);
  if (!latest || latest.analysis.promptVersionId !== current.id) return null;
  const tokens = await estimateText(db, { text: current.promptText, modelId: isSupportedModel(targetModel) ? targetModel : DEFAULT_TARGET_MODEL });
  return presentStored({ ...latest, reused: true }, current.promptText, prompt.currentVersionId, tokens, null);
}
