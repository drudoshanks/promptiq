import { createHash } from "node:crypto";

import { AppError } from "@/lib/api/errors";
import type { TaskCategory } from "@/lib/categories";
import { HARD_MAX_PROMPT_CHARS, planFor } from "@/lib/config/plans";
import { estimateCostUsd } from "@/lib/cost";
import type { AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { RequestLogger } from "@/lib/logger";
import { ProviderError, type OptimiserProvider, type ProviderUsage } from "@/lib/providers/types";
import { listEnabledPreferences } from "@/lib/services/preferences";
import { createPrompt } from "@/lib/services/prompts";
import {
  assertQuotaAvailable,
  globalSpendTodayUsd,
  idempotencyKeyUsed,
  linkRunToVersions,
  recordRun,
  recordUsage,
} from "@/lib/services/usage";
import { estimateTokens, type TokenEstimateMethod } from "@/lib/tokens";

import { TEMPLATE_VERSION } from "./instructions";
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
  token_estimate: { before: number; after: number; method: TokenEstimateMethod };
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    source: "provider" | "unavailable";
  };
  estimated_cost_usd: number | null;
  model_id: string;
  template_version: string;
  latency_ms: number;
  saved_prompt_id: string | null;
  saved_version_ids: { original: string; optimised: string } | null;
  preferences_applied: PreferenceResolution;
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

/**
 * Optimisation pipeline (SRS §7.1). Every failure path records a run with the
 * right status and throws an AppError with a safe, actionable code (§10.6).
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

  // Idempotent replay / duplicate protection.
  if (ctx.idempotencyKey) {
    const cached = replayCache.get(replayKey(user.id, ctx.idempotencyKey));
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    const used = await idempotencyKeyUsed(db, replayKey(user.id, ctx.idempotencyKey));
    if (used) {
      throw new AppError("CONFLICT", "This request was already processed.", {
        details: { optimisation_id: used.runId },
      });
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
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    const reason = error instanceof ProviderError ? error.reason : "unknown";
    await recordRun(db, {
      userId: user.id,
      provider: provider.name,
      modelId: provider.modelId,
      templateVersion: TEMPLATE_VERSION,
      taskCategory: input.taskCategory === "auto" ? null : input.taskCategory,
      status: "failed",
      inputChars: prompt.length,
      latencyMs,
      requestId: ctx.requestId,
      errorCode: `${code}:${reason}`,
    });
    log.warn("optimisation failed", { code, reason, latency_ms: latencyMs, model_id: provider.modelId });
    const retryAfter = error instanceof ProviderError ? error.retryAfterSeconds : undefined;
    throw new AppError(
      code,
      code === "PROVIDER_TIMEOUT"
        ? "The optimiser took too long to respond. Your prompt is unchanged — please try again."
        : "The optimisation service is temporarily unavailable. Your prompt is unchanged — please try again shortly.",
      { details: { reason }, headers: retryAfter ? { "Retry-After": String(retryAfter) } : {} },
    );
  }

  const latencyMs = Date.now() - startedAt;
  const usage = normaliseUsage(result.usage);
  const estimatedCost = usage.input_tokens !== null && usage.output_tokens !== null
    ? estimateCostUsd(result.modelId, {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.cached_input_tokens ?? 0,
        outputTokens: usage.output_tokens,
      })
    : null;

  const baseRun = {
    userId: user.id,
    provider: provider.name,
    modelId: result.modelId,
    templateVersion: TEMPLATE_VERSION,
    taskCategory: input.taskCategory === "auto" ? null : input.taskCategory,
    inputChars: prompt.length,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    estimatedCostUsd: estimatedCost,
    latencyMs,
    requestId: result.providerRequestId ?? ctx.requestId,
  };

  // 6. Refusal / incomplete / malformed output: safe errors, no success record.
  if (result.kind === "refused") {
    await recordRun(db, { ...baseRun, status: "refused", errorCode: "OPTIMISATION_REFUSED" });
    log.info("optimisation refused", { latency_ms: latencyMs, model_id: result.modelId });
    throw new AppError("OPTIMISATION_REFUSED", "The optimiser declined to rewrite this prompt. Your original text is unchanged.", {
      details: { reason: result.reason.slice(0, 300) },
    });
  }
  if (result.kind === "incomplete") {
    await recordRun(db, { ...baseRun, status: "incomplete", errorCode: `INCOMPLETE:${result.reason}` });
    log.warn("optimisation incomplete", { reason: result.reason, latency_ms: latencyMs });
    throw new AppError("INVALID_MODEL_OUTPUT", "The optimiser returned an incomplete result. Try a shorter prompt or try again.", {
      details: { reason: result.reason },
    });
  }
  if (result.kind === "invalid_output") {
    await recordRun(db, { ...baseRun, status: "failed", errorCode: "INVALID_MODEL_OUTPUT" });
    log.error("optimiser output invalid", { reason: result.reason, latency_ms: latencyMs });
    throw new AppError("INVALID_MODEL_OUTPUT", "The optimiser returned an unexpected result. Please try again.");
  }

  // 7. Advisory token estimates from the server-side tokenizer, not the model.
  const output = result.output;
  const before = estimateTokens(prompt);
  const after = estimateTokens(output.optimised_prompt);
  const taskCategory: TaskCategory = output.task_category;

  const run = await recordRun(db, {
    ...baseRun,
    taskCategory,
    status: "succeeded",
    outputChars: output.optimised_prompt.length,
  });

  // 8. History (only when enabled; FR-009, A-07).
  let savedPromptId: string | null = null;
  let savedVersionIds: OptimisationResponse["saved_version_ids"] = null;
  const wantsSave = input.options?.saveToHistory ?? true;
  if (user.historyEnabled && wantsSave) {
    try {
      const saved = await createPrompt(db, user.id, plan, {
        title: input.options?.title,
        category: taskCategory,
        versions: [
          { promptText: prompt, provenance: "original" },
          { promptText: output.optimised_prompt, provenance: "ai_optimised", changeSummary: output.change_summary },
        ],
      });
      const [original, optimised] = saved.versions;
      if (original && optimised) {
        savedPromptId = saved.id;
        savedVersionIds = { original: original.id, optimised: optimised.id };
        await linkRunToVersions(db, run.id, { promptId: saved.id, sourceVersionId: original.id, resultVersionId: optimised.id });
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

  // 9. Consume quota exactly once.
  await recordUsage(db, {
    userId: user.id,
    runId: run.id,
    idempotencyKey: ctx.idempotencyKey ? replayKey(user.id, ctx.idempotencyKey) : null,
    inputTokens: usage.input_tokens ?? before.tokens,
    outputTokens: usage.output_tokens ?? after.tokens,
    costUsd: estimatedCost ?? 0,
  });

  log.info("optimisation succeeded", {
    optimisation_id: run.id,
    model_id: result.modelId,
    template_version: TEMPLATE_VERSION,
    task_category: taskCategory,
    latency_ms: latencyMs,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    estimated_cost_usd: estimatedCost,
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
    token_estimate: { before: before.tokens, after: after.tokens, method: before.method },
    usage,
    estimated_cost_usd: estimatedCost,
    model_id: result.modelId,
    template_version: TEMPLATE_VERSION,
    latency_ms: latencyMs,
    saved_prompt_id: savedPromptId,
    saved_version_ids: savedVersionIds,
    preferences_applied: { effective, sources: resolution.sources },
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

function normaliseUsage(usage: ProviderUsage): OptimisationResponse["usage"] {
  const has = typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number";
  return {
    input_tokens: has ? (usage.inputTokens as number) : null,
    output_tokens: has ? (usage.outputTokens as number) : null,
    cached_input_tokens: has ? (usage.cachedInputTokens ?? 0) : null,
    source: has ? "provider" : "unavailable",
  };
}
