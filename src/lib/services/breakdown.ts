import { randomUUID } from "node:crypto";

import { AppError } from "@/lib/api/errors";
import { planFor } from "@/lib/config/plans";
import type { TaskCategory } from "@/lib/categories";
import { stepLevels } from "@/lib/intelligence/breakdown";
import { INTENT_LABELS, TO_TASK_CATEGORY, type IntentCategory } from "@/lib/intelligence/categories";
import { breakdownText, quickClassification } from "@/lib/intelligence/engine";
import { REQUIREMENT_KIND_LABELS } from "@/lib/intelligence/requirements";
import { BREAKDOWN_LIMITS } from "@/lib/intelligence/schemas";
import { wordCount } from "@/lib/intelligence/text";
import { userKeyFor } from "@/lib/optimiser/service";
import { isModelProvider } from "@/lib/providers/types";

import { providerFailure } from "./analysis";
import { assertSpendCap, recordAdhocUsage, resolveModel, resolveSource, type IntelligenceContext, type Source } from "./intelligence";
import { getPromptPreferences, preferencesForModel } from "./prompt-preferences";
import { countPrompts, createPrompt } from "./prompts";
import { assertAnalysisQuotaAvailable, recordAnalysisUsage } from "./usage";

/**
 * Breakdown service: split one prompt into a sequence of smaller prompts
 * with advice on running them. Model use counts as one prompt analysis;
 * the rule-based splitter is free. Nothing is stored unless the user saves
 * the steps to My prompts.
 */
export const MIN_BREAKDOWN_WORDS = 6;

export interface BreakdownForUserInput {
  source: Source;
  category?: IntentCategory | null;
  targetModel?: string | null;
}

export async function breakdownForUser(ctx: IntelligenceContext, input: BreakdownForUserInput) {
  const { db, user } = ctx;
  const src = await resolveSource(ctx, input.source);
  if (wordCount(src.text) < MIN_BREAKDOWN_WORDS) {
    throw new AppError("VALIDATION_ERROR", "This prompt is too short to break down. It's already a single, focused request.");
  }
  const prefs = await getPromptPreferences(db, user.id);
  const targetModel = resolveModel(input.targetModel, src.targetModel ?? prefs.preferredModel);
  const usesModel = isModelProvider(ctx.provider.name);
  if (usesModel) {
    await assertAnalysisQuotaAvailable(db, user);
    await assertSpendCap(ctx);
  }

  const classification = quickClassification(src.text, input.category ?? null);
  const operationId = randomUUID();
  let result: Awaited<ReturnType<typeof breakdownText>>;
  try {
    result = await breakdownText({ text: src.text, classification, targetModel, provider: ctx.provider, preferences: preferencesForModel(prefs), requestId: ctx.requestId, userKey: userKeyFor(user.id) });
  } catch (error) {
    const failure = providerFailure(error);
    await recordAdhocUsage(ctx, operationId, failure.attempts, "prompt_breakdown");
    throw failure.appError;
  }
  const usage = await recordAdhocUsage(ctx, operationId, result.attempts, "prompt_breakdown");
  if (result.engine === "model") {
    await recordAnalysisUsage(db, { userId: user.id, analysisId: operationId, inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, costUsd: usage.actual_cost ?? 0 });
  }
  ctx.log.info("breakdown completed", { engine: result.engine, steps: result.plan.steps.length, fallback: Boolean(result.fallback_reason) });

  const levels = stepLevels(result.plan.steps);
  const parallelWith = (n: number) => result.plan.steps.filter((s) => s.number !== n && levels.get(s.number) === levels.get(n)).map((s) => s.number);
  const steps = result.plan.steps.map((s, i) => ({
    number: s.number,
    title: s.title,
    goal: s.goal,
    prompt: s.prompt,
    depends_on: s.depends_on,
    parallel_with: parallelWith(s.number),
    expected_output: s.expected_output,
    how_to_use: s.how_to_use,
    checks: s.checks,
    requirement_ids: s.requirement_ids,
    is_review: s.is_review,
    tokens: result.tokens.steps[i] ?? 0,
  }));
  const added = result.coverage.filter((c) => c.status === "added").length;
  return {
    breakdown_id: operationId,
    prompt_id: src.promptId,
    prompt_version_id: src.versionId,
    title: result.plan.title,
    strategy: result.plan.strategy,
    engine: result.engine,
    fallback_reason: result.fallback_reason,
    category: classification.primary,
    category_label: INTENT_LABELS[classification.primary],
    assessment: result.assessment,
    shared_context: result.plan.shared_context,
    run_mode: result.plan.run_mode,
    steps,
    usage_advice: result.plan.usage_advice,
    coverage: {
      total: result.coverage.length,
      covered: result.coverage.length - added,
      added,
      items: result.coverage.map((c) => ({ id: c.id, text: c.text, kind: c.kind, kind_label: REQUIREMENT_KIND_LABELS[c.kind], steps: c.steps, status: c.status })),
      summary:
        result.coverage.length === 0
          ? "No explicit requirements were detected, so there was nothing to check."
          : added === 0
            ? `All ${result.coverage.length} requirement${result.coverage.length === 1 ? " is" : "s are"} carried by at least one step.`
            : `${added} requirement${added === 1 ? " was" : "s were"} missing from the steps and ${added === 1 ? "has" : "have"} been added under “Also make sure”.`,
    },
    tokens: { model: targetModel, original: result.tokens.original, steps_total: result.tokens.total },
    usage: result.attempts.length ? usage : null,
  };
}

export type IntelligenceBreakdown = Awaited<ReturnType<typeof breakdownForUser>>;

// ---------------------------------------------------------------------------
// Saving the steps
// ---------------------------------------------------------------------------
export interface SaveBreakdownInput {
  title: string;
  category: IntentCategory;
  targetModel?: string | null;
  steps: Array<{ title: string; prompt: string; how_to_use?: string | null }>;
  breakdownId?: string | null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 22).replace(/-+$/, "") || "steps";
}

/**
 * Save each step as its own prompt in My prompts, tagged so the sequence can
 * be found together. All or nothing: the library limit is checked up front.
 */
export async function saveBreakdownSteps(ctx: IntelligenceContext, input: SaveBreakdownInput) {
  const { db, user } = ctx;
  const plan = planFor(user.planCode);
  const steps = input.steps.filter((s) => s.prompt.trim()).slice(0, BREAKDOWN_LIMITS.maxSteps);
  if (steps.length < 1) throw new AppError("VALIDATION_ERROR", "There are no steps to save.");
  const tooLong = steps.find((s) => s.prompt.length > Math.min(plan.maxPromptChars, BREAKDOWN_LIMITS.maxStepChars));
  if (tooLong) throw new AppError("PROMPT_TOO_LONG", `"${tooLong.title}" is longer than your plan allows for one prompt.`);
  const existing = await countPrompts(db, user.id);
  if (existing + steps.length > plan.maxSavedPrompts) {
    throw new AppError("FORBIDDEN", `Saving ${steps.length} steps would go over your plan's ${plan.maxSavedPrompts} saved prompts (you have ${existing}). Archive or delete some prompts, or upgrade.`, {
      details: { limit: plan.maxSavedPrompts, used: existing, needed: steps.length },
    });
  }
  const tag = `steps-${slug(input.title)}`;
  const category: TaskCategory = TO_TASK_CATEGORY[input.category];
  const saved: Array<{ id: string; title: string }> = [];
  for (const [i, s] of steps.entries()) {
    const p = await createPrompt(db, user.id, plan, {
      title: `${i + 1}/${steps.length} ${s.title}`.slice(0, 200),
      description: [`Step ${i + 1} of ${steps.length} in “${input.title}”.`, s.how_to_use?.trim() ?? ""].filter(Boolean).join(" ").slice(0, 1000),
      category,
      tags: ["breakdown", tag],
      targetModel: input.targetModel ?? null,
      versions: [{ promptText: s.prompt, provenance: "ai_optimised", changeSummary: [`Step ${i + 1} of ${steps.length} from Break down in the Studio.`] }],
    });
    saved.push({ id: p.id, title: p.title });
  }
  return { tag, prompts: saved, library_url: `/app/library?tag=${encodeURIComponent(tag)}` };
}
