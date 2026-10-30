import { createHash } from "node:crypto";

import { AppError } from "@/lib/api/errors";
import type { TaskCategory } from "@/lib/categories";
import type { OutputLengthPreset } from "@/lib/config/estimates";
import { DEFAULT_TARGET_MODEL, isSupportedModel } from "@/lib/config/models";
import { HARD_MAX_PROMPT_CHARS, planFor } from "@/lib/config/plans";
import type { AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { RequestLogger } from "@/lib/logger";
import { ProviderError, type OptimiserProvider, type ProviderAttempt } from "@/lib/providers/types";
import { sumUsage } from "@/lib/providers/usage";
import {
  compareTexts,
  recordApiUsage,
  recordTokenEstimate,
  summariseUsage,
  type TokenComparisonResult,
} from "@/lib/services/estimates";
import { listEnabledPreferences } from "@/lib/services/preferences";
import { createPrompt, refreshPromptStats } from "@/lib/services/prompts";
import {
  assertQuotaAvailable,
  finaliseRun,
  globalSpendTodayUsd,
  idempotencyKeyUsed,
  linkRunToVersions,
  recordRun,
  recordRunComparison,
  recordUsage,
} from "@/lib/services/usage";
import type { ApiUsageRecord, RunStatus } from "@/lib/db/schema";

import { TEMPLATE_VERSION, type OptimiserMode } from "./instructions";
import { normalisePrompt } from "./normalise";
import { resolvePreferences, type EffectivePreferences, type PreferenceResolution } from "./preferences";

export interface OptimiseServiceInput {
  prompt: string;
  taskCategory: TaskCategory | "auto";
  preferences?: Record<string, unknown>;
  options?: {
    saveToHistory?: boolean;
    outputStyle?: "structured" | "natural";
    maxOutputTokens?: number;
    title?: string;
    /** Model the user will run the prompt on; drives the token/cost estimate only. */
    targetModel?: string;
    expectedOutput?: OutputLengthPreset | number;
    mode?: OptimiserMode;
    customObjective?: string | null;
    /** Recommendations of suggestions the user accepted, to apply. */
    acceptedSuggestions?: string[];
    /**
     * Optimising a saved library prompt: the run is linked to the prompt and
     * source version, and NO version is created — the user reviews the proposal
     * and saves it explicitly (Prompt Library §6: never overwrite automatically).
     */
    library?: { promptId: string; sourceVersionId: string };
  };
}

export interface OptimisationResponse {
  optimisation_id: string;
  task_category: TaskCategory;
  original_prompt: string;
  optimised_prompt: string;
  change_summary: string[];
  assumptions: string[];
  clarification_needed: boolean;
  clarifying_questions: string[];
  quality_risks: string[];
  /** Kept for API compatibility: counts from the target model's tokenizer. */
  token_estimate: { before: number; after: number; method: string };
  /** Original vs optimised counts and cost for the target model. Estimates only. */
  estimate: TokenComparisonResult;
  /** PromptIQ's own optimisation call(s), as reported by the provider. */
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    source: "provider" | "unavailable";
  };
  actual_usage: ReturnType<typeof summariseUsage>;
  /** Actual cost of PromptIQ's optimisation call(s), priced with the snapshot in force. */
  estimated_cost_usd: number | null;
  model_id: string;
  template_version: string;
  latency_ms: number;
  saved_prompt_id: string | null;
  saved_version_ids: { original: string; optimised: string } | null;
  preferences_applied: PreferenceResolution;
  optimisation_mode: OptimiserMode;
  applied_suggestion_count: number;
}

export interface OptimiseServiceContext {
  db: Db;
  user: AppUser;
  provider: OptimiserProvider;
  requestId: string;
  idempotencyKey: string | null;
  log: RequestLogger;
  globalDailySpendCapUsd: number;
  maxOutputTokensCeiling: number;
}

// Replay cache for idempotent retries (10 minutes, in-process). The durable guard
// against double quota consumption is the unique key on usage_events.
const replayCache = new Map<string, { expiresAt: number; response: OptimisationResponse }>();
const REPLAY_TTL_MS = 10 * 60 * 1000;

function replayKey(userId: string, idempotencyKey: string) {
  return `${userId}:${idempotencyKey}`;
}

export function userKeyFor(userId: string): string {
  return createHash("sha256").update(`promptiq:${userId}`).digest("hex").slice(0, 32);
}

const REQUEST_TYPE = "prompt_optimisation";

/**
 * Write one api_usage_records row per provider attempt and return the totals.
 * (run_id, attempt) is unique, so a repeated write can never double-count.
 */
async function recordAttempts(db: Db, userId: string, runId: string, provider: string, attempts: ProviderAttempt[]) {
  const records: ApiUsageRecord[] = [];
  let pricingVersion: string | null = null;
  for (const a of attempts) {
    const recorded = await recordApiUsage(db, {
      userId,
      runId,
      attempt: a.attempt,
      provider,
      modelId: a.modelId,
      requestType: REQUEST_TYPE,
      providerRequestId: a.providerRequestId ?? null,
      status: a.status,
      inputTokens: a.usage?.inputTokens ?? 0,
      outputTokens: a.usage?.outputTokens ?? 0,
      cachedInputTokens: a.usage?.cachedInputTokens ?? null,
      usageReported: a.usage !== null,
    });
    if (recorded) {
      records.push(recorded.record);
      pricingVersion ??= recorded.record.pricingVersion;
    }
  }
  const usage = sumUsage(attempts.map((a) => a.usage));
  const summary = summariseUsage(records);
  return { records, usage, summary, pricingVersion, attemptCount: Math.max(1, attempts.length) };
}

/**
 * Optimisation pipeline (SRS §7.1). Every failure path finalises the run with
 * the right status and the usage the provider reported, then throws an AppError
 * with a safe, actionable code (§10.6).
 */
export async function optimisePromptForUser(ctx: OptimiseServiceContext, input: OptimiseServiceInput): Promise<OptimisationResponse> {
  const { db, user, provider, log } = ctx;
  const plan = planFor(user.planCode);
  const startedAt = Date.now();

  // 1. Validate request, entitlement, input length.
  const prompt = normalisePrompt(input.prompt);
  if (!prompt) throw new AppError("PROMPT_EMPTY", "Please enter a prompt to optimise.");
  if (prompt.length > Math.min(plan.maxPromptChars, HARD_MAX_PROMPT_CHARS)) {
    throw new AppError("PROMPT_TOO_LONG", `Prompts on the ${plan.name} plan can be up to ${plan.maxPromptChars.toLocaleString("en")} characters.`, {
      details: { limit: plan.maxPromptChars, length: prompt.length, upgrade_available: user.planCode === "free" },
    });
  }
  const targetModel = input.options?.targetModel ?? DEFAULT_TARGET_MODEL;
  if (!isSupportedModel(targetModel)) {
    throw new AppError("UNSUPPORTED_MODEL", `Token estimates are not available for model "${targetModel}".`);
  }

  // Idempotent replay / duplicate protection.
  if (ctx.idempotencyKey) {
    const cached = replayCache.get(replayKey(user.id, ctx.idempotencyKey));
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    const used = await idempotencyKeyUsed(db, replayKey(user.id, ctx.idempotencyKey));
    if (used) {
      throw new AppError("CONFLICT", "This request was already processed.", { details: { optimisation_id: used.runId } });
    }
  }

  // Quota and spend controls (FR-013, NFR-012).
  await assertQuotaAvailable(db, user);
  if (ctx.globalDailySpendCapUsd > 0) {
    const spentToday = await globalSpendTodayUsd(db);
    if (spentToday >= ctx.globalDailySpendCapUsd) {
      log.error("global daily spend cap reached", { spent_today_usd: spentToday, cap_usd: ctx.globalDailySpendCapUsd });
      throw new AppError("SPEND_CAP_REACHED", "Optimisation is temporarily paused. Please try again later.");
    }
  }

  // 2–3. Preferences (only user-owned, only when personalisation is on; FR-004).
  const saved = user.personalisationEnabled ? await listEnabledPreferences(db, user.id) : [];
  const resolution = resolvePreferences({
    taskCategory: input.taskCategory,
    requestPreferences: input.preferences,
    savedPreferences: saved,
    personalisationEnabled: user.personalisationEnabled,
  });
  const effective: EffectivePreferences = { ...resolution.effective };
  if (input.options?.outputStyle === "structured" && !effective.format) effective.format = "structured";

  const maxOutputTokens = Math.min(ctx.maxOutputTokensCeiling, Math.max(300, input.options?.maxOutputTokens ?? ctx.maxOutputTokensCeiling));

  // The logical operation exists before the provider is called, so every
  // attempt (including ones that fail) can be attributed to it.
  const library = input.options?.library ?? null;
  const mode: OptimiserMode = input.options?.mode ?? "balanced";
  const acceptedSuggestions = (input.options?.acceptedSuggestions ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const run = await recordRun(db, {
    userId: user.id,
    provider: provider.name,
    modelId: provider.modelId,
    templateVersion: TEMPLATE_VERSION,
    taskCategory: input.taskCategory === "auto" ? null : input.taskCategory,
    status: "queued",
    inputChars: prompt.length,
    latencyMs: 0,
    requestId: ctx.requestId,
    promptId: library?.promptId ?? null,
    sourceVersionId: library?.sourceVersionId ?? null,
  });

  const close = async (status: RunStatus, attempts: ProviderAttempt[], extra: { modelId?: string; errorCode?: string | null; taskCategory?: string | null; outputChars?: number | null; requestId?: string | null } = {}) => {
    const totals = await recordAttempts(db, user.id, run.id, provider.name, attempts);
    const finalised = await finaliseRun(db, run.id, {
      status,
      modelId: extra.modelId ?? provider.modelId,
      ...(extra.taskCategory !== undefined ? { taskCategory: extra.taskCategory } : {}),
      outputChars: extra.outputChars ?? null,
      inputTokens: totals.usage?.inputTokens ?? null,
      outputTokens: totals.usage?.outputTokens ?? null,
      cachedInputTokens: totals.usage ? (totals.usage.cachedInputTokens ?? 0) : null,
      costUsd: totals.summary.actual_cost,
      pricingVersion: totals.pricingVersion,
      attemptCount: totals.attemptCount,
      latencyMs: Date.now() - startedAt,
      ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
      errorCode: extra.errorCode ?? null,
    });
    return { totals, run: finalised };
  };

  // 4–5. Provider call.
  let result;
  try {
    result = await provider.optimise({
      prompt,
      taskCategory: input.taskCategory,
      preferences: effective as Record<string, string>,
      maxOutputTokens,
      requestId: ctx.requestId,
      userKey: userKeyFor(user.id),
      mode,
      customObjective: mode === "custom" ? (input.options?.customObjective ?? null) : null,
      acceptedSuggestions,
    });
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    const reason = error instanceof ProviderError ? error.reason : "unknown";
    const attempts = error instanceof ProviderError ? error.attempts : [];
    await close("failed", attempts, { errorCode: `${code}:${reason}` });
    if (library) await refreshPromptStats(db, library.promptId);
    log.warn("optimisation failed", { code, reason, attempts: attempts.length, latency_ms: Date.now() - startedAt, model_id: provider.modelId });
    const retryAfter = error instanceof ProviderError ? error.retryAfterSeconds : undefined;
    throw new AppError(
      code,
      code === "PROVIDER_TIMEOUT"
        ? "The optimiser took too long to respond. Your prompt is unchanged — please try again."
        : "The optimisation service is temporarily unavailable. Your prompt is unchanged — please try again shortly.",
      { details: { reason }, headers: retryAfter ? { "Retry-After": String(retryAfter) } : {} },
    );
  }

  const requestId = result.providerRequestId ?? ctx.requestId;

  // 6. Refusal / incomplete / malformed output: safe errors, no success record.
  if (result.kind === "refused") {
    await close("refused", result.attempts, { modelId: result.modelId, errorCode: "OPTIMISATION_REFUSED", requestId });
    log.info("optimisation refused", { model_id: result.modelId });
    throw new AppError("OPTIMISATION_REFUSED", "The optimiser declined to rewrite this prompt. Your original text is unchanged.", {
      details: { reason: result.reason.slice(0, 300) },
    });
  }
  if (result.kind === "incomplete") {
    await close("incomplete", result.attempts, { modelId: result.modelId, errorCode: `INCOMPLETE:${result.reason}`, requestId });
    log.warn("optimisation incomplete", { reason: result.reason });
    throw new AppError("INVALID_MODEL_OUTPUT", "The optimiser returned an incomplete result. Try a shorter prompt or try again.", {
      details: { reason: result.reason },
    });
  }
  if (result.kind === "invalid_output") {
    await close("failed", result.attempts, { modelId: result.modelId, errorCode: "INVALID_MODEL_OUTPUT", requestId });
    log.error("optimiser output invalid", { reason: result.reason });
    throw new AppError("INVALID_MODEL_OUTPUT", "The optimiser returned an unexpected result. Please try again.");
  }

  const output = result.output;
  const taskCategory: TaskCategory = output.task_category;
  const { totals, run: finalRun } = await close("succeeded", result.attempts, {
    modelId: result.modelId,
    taskCategory,
    outputChars: output.optimised_prompt.length,
    requestId,
  });

  // 7. Token comparison and cost estimate for the target model. Server-side
  // tokenizer counts; the model's own token estimates are ignored (§7.3).
  const estimate = await compareTexts(db, {
    original: prompt,
    optimised: output.optimised_prompt,
    modelId: targetModel,
    expectedOutput: input.options?.expectedOutput,
  });

  await recordRunComparison(db, run.id, {
    mode,
    targetModel: estimate.model,
    tokensSaved: estimate.tokens_saved,
    reductionPercent: estimate.reduction_percent,
    inputCostBefore: estimate.cost?.input_cost_before ?? null,
    inputCostAfter: estimate.cost?.input_cost_after ?? null,
    appliedSuggestionCount: acceptedSuggestions.length,
  });

  // 8. History (auto-save; only when enabled and not a library optimisation; FR-009, A-07).
  let savedPromptId: string | null = library?.promptId ?? null;
  let savedVersionIds: OptimisationResponse["saved_version_ids"] = null;
  const wantsSave = input.options?.saveToHistory ?? true;
  if (!library && user.historyEnabled && wantsSave) {
    try {
      const savedPrompt = await createPrompt(db, user.id, plan, {
        title: input.options?.title,
        category: taskCategory,
        targetModel: estimate.model,
        versions: [
          { promptText: prompt, provenance: "original" },
          { promptText: output.optimised_prompt, provenance: "ai_optimised", changeSummary: output.change_summary },
        ],
      });
      const [original, optimised] = savedPrompt.versions;
      if (original && optimised) {
        savedPromptId = savedPrompt.id;
        savedVersionIds = { original: original.id, optimised: optimised.id };
        await linkRunToVersions(db, run.id, { promptId: savedPrompt.id, sourceVersionId: original.id, resultVersionId: optimised.id });
        await refreshPromptStats(db, savedPrompt.id);
      }
    } catch (error) {
      // A full library must not lose the optimisation result: return it unsaved.
      if (error instanceof AppError && error.code === "FORBIDDEN") {
        log.info("history save skipped: library limit", { limit: error.details["limit"] });
      } else {
        throw error;
      }
    }
  }

  // Persist the two estimates once per optimisation (never per keystroke).
  const asEstimate = (side: "original" | "optimised") => ({
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
  });
  if (library) await refreshPromptStats(db, library.promptId);
  await recordTokenEstimate(db, { userId: user.id, label: "original", runId: run.id, promptVersionId: savedVersionIds?.original ?? library?.sourceVersionId ?? null, estimate: asEstimate("original") });
  await recordTokenEstimate(db, { userId: user.id, label: "optimised", runId: run.id, promptVersionId: savedVersionIds?.optimised ?? null, estimate: asEstimate("optimised") });

  // 9. Consume quota exactly once per logical operation, with the summed usage.
  await recordUsage(db, {
    userId: user.id,
    runId: run.id,
    idempotencyKey: ctx.idempotencyKey ? replayKey(user.id, ctx.idempotencyKey) : null,
    inputTokens: totals.usage?.inputTokens ?? 0,
    outputTokens: totals.usage?.outputTokens ?? 0,
    costUsd: totals.summary.actual_cost ?? 0,
  });

  log.info("optimisation succeeded", {
    optimisation_id: run.id,
    model_id: result.modelId,
    template_version: TEMPLATE_VERSION,
    task_category: taskCategory,
    latency_ms: finalRun.latencyMs,
    attempts: totals.attemptCount,
    input_tokens: totals.usage?.inputTokens ?? null,
    output_tokens: totals.usage?.outputTokens ?? null,
    cached_input_tokens: totals.usage?.cachedInputTokens ?? null,
    actual_cost_usd: totals.summary.actual_cost,
    pricing_version: totals.pricingVersion,
    target_model: estimate.model,
    saved: Boolean(savedPromptId),
  });

  const response: OptimisationResponse = {
    optimisation_id: run.id,
    task_category: taskCategory,
    original_prompt: prompt,
    optimised_prompt: output.optimised_prompt,
    change_summary: output.change_summary,
    assumptions: output.assumptions,
    clarification_needed: output.clarification_needed,
    clarifying_questions: output.clarifying_questions,
    quality_risks: output.quality_risks,
    token_estimate: { before: estimate.original.token_count, after: estimate.optimised.token_count, method: `tokenizer:${estimate.encoding}` },
    estimate,
    usage: {
      input_tokens: totals.usage?.inputTokens ?? null,
      output_tokens: totals.usage?.outputTokens ?? null,
      cached_input_tokens: totals.usage ? (totals.usage.cachedInputTokens ?? 0) : null,
      source: totals.usage ? "provider" : "unavailable",
    },
    actual_usage: totals.summary,
    estimated_cost_usd: totals.summary.actual_cost,
    model_id: result.modelId,
    template_version: TEMPLATE_VERSION,
    latency_ms: finalRun.latencyMs ?? Date.now() - startedAt,
    saved_prompt_id: savedPromptId,
    saved_version_ids: savedVersionIds,
    preferences_applied: { effective, sources: resolution.sources },
    optimisation_mode: mode,
    applied_suggestion_count: acceptedSuggestions.length,
  };

  if (ctx.idempotencyKey) {
    replayCache.set(replayKey(user.id, ctx.idempotencyKey), { expiresAt: Date.now() + REPLAY_TTL_MS, response });
    if (replayCache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of replayCache) if (v.expiresAt <= now) replayCache.delete(k);
    }
  }
  return response;
}
