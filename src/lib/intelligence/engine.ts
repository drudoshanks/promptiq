import { INTELLIGENCE_CONFIG } from "@/lib/config/intelligence";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import type { IntelligenceProvider, ProviderAttempt, StructuredResult } from "@/lib/providers/types";
import { countTokens } from "@/lib/tokens";

import { isIntentCategory, type GenerationMode, type IntentCategory, type SuggestionKind } from "./categories";
import { classifyByRules, detectMissingInformation, withUserCategory, type Classification, type MissingInfo } from "./classifier";
import { budgetAdvice, guardedCompress } from "./compress";
import { INTELLIGENCE_TEMPLATE_VERSION } from "./instructions";
import type { RankingContext } from "./ranking";
import { extractRequirements, validatePreservation, type PreservationReport, type Requirement, type SemanticCompare } from "./requirements";
import type { IntentRepresentation, ModelAnalysis } from "./schemas";
import { scorePrompt, SCORE_NOTE, type CompletenessScore } from "./scorer";
import { buildIntent, defaultAssumptions } from "./structure";
import { buildSuggestions, type EngineSuggestion } from "./suggestions";
import { templateFor, type PromptTemplate } from "./templates";
import { similarity, wordCount } from "./text";

/**
 * Pipeline orchestration, independent of storage. The service layer adds
 * ownership, quotas, persistence and usage accounting around these functions.
 */
export class EngineProviderError extends Error {
  constructor(
    readonly kind: "refused" | "incomplete" | "invalid_output",
    readonly reason: string,
    readonly attempts: ProviderAttempt[],
  ) {
    super(`${kind}: ${reason}`);
    this.name = "EngineProviderError";
  }
}

/** Accumulates attempts across several provider calls with continuous numbering. */
export class AttemptLog {
  readonly attempts: ProviderAttempt[] = [];
  add(list: ProviderAttempt[]) {
    for (const a of list) this.attempts.push({ ...a, attempt: this.attempts.length + 1 });
  }
}

/** Unwrap a provider result; a non-ok result becomes an EngineProviderError with every attempt so far. */
export function unwrap<T>(result: StructuredResult<T>, log: AttemptLog): T {
  log.add(result.attempts);
  if (result.kind === "ok") return result.output;
  throw new EngineProviderError(result.kind, result.reason, log.attempts);
}

export interface AnalysisInput {
  text: string;
  categoryOverride?: IntentCategory | null;
  targetModel?: string | null;
  provider: IntelligenceProvider | null;
  ranking: RankingContext;
  preferences: Record<string, unknown>;
  requestId: string;
  userKey: string;
  /** Distinguishes suggestion IDs per analysed version. */
  versionKey: string;
  log?: AttemptLog;
}

export interface AnalysisResult {
  classification: Classification;
  score: CompletenessScore & { note: string };
  requirements: Requirement[];
  model_requirements: string[];
  intent: IntentRepresentation;
  suggestions: EngineSuggestion[];
  already_well_optimised: boolean;
  clarification_questions: MissingInfo[];
  assumptions: string[];
  model_used: boolean;
  template: { id: string; label: string; version: number };
  template_version: string;
  attempts: ProviderAttempt[];
}

/** Model help is worth a call for ambiguous or non-trivial prompts only. */
export function shouldUseModel(rules: Classification, text: string): boolean {
  return rules.ambiguous || wordCount(text) >= 12;
}

export async function analyseText(input: AnalysisInput): Promise<AnalysisResult> {
  const log = input.log ?? new AttemptLog();
  const rules = classifyByRules(input.text);
  let classification = rules;
  let model: ModelAnalysis | null = null;

  if (input.provider && shouldUseModel(rules, input.text)) {
    model = unwrap(await input.provider.analyseIntent({ prompt: input.text, targetModel: input.targetModel ?? null, preferences: input.preferences, requestId: input.requestId, userKey: input.userKey }), log);
    if (rules.ambiguous && isIntentCategory(model.primary_category)) {
      classification = {
        ...rules,
        primary: model.primary_category,
        secondary: model.secondary_category && model.secondary_category !== model.primary_category ? model.secondary_category : null,
        objective: model.objective || rules.objective,
        confidence: Math.round(model.confidence * 100) / 100,
        template_id: templateFor(model.primary_category).id,
        missing_information: detectMissingInformation(input.text, model.primary_category),
        method: "model",
        ambiguous: false,
      };
    }
    // Union of missing information (model items only when the key is new).
    const keys = new Set(classification.missing_information.map((m) => m.key));
    for (const m of model.missing_information) if (!keys.has(m.key)) classification.missing_information.push(m);
  }
  if (input.categoryOverride) classification = withUserCategory(classification, input.categoryOverride, input.text);

  const requirements = extractRequirements(input.text);
  const modelRequirements = (model?.requirements ?? []).map((r) => r.text).filter((t) => !requirements.some((r) => similarity(r.text, t) >= 0.6));
  const score = scorePrompt(input.text, classification.primary, classification.missing_information, requirements);
  const { suggestions, already_well_optimised } = buildSuggestions({
    text: input.text,
    classification,
    score,
    model,
    ranking: input.ranking,
    modelId: input.targetModel ?? DEFAULT_TARGET_MODEL,
    versionKey: input.versionKey,
  });
  const template = templateFor(classification.primary);
  return {
    classification,
    score: { ...score, note: SCORE_NOTE },
    requirements,
    model_requirements: modelRequirements.slice(0, 12),
    intent: buildIntent({ text: input.text, classification, requirements }),
    suggestions,
    already_well_optimised,
    clarification_questions: classification.missing_information,
    assumptions: defaultAssumptions(classification),
    model_used: model !== null,
    template: { id: template.id, label: template.label, version: template.version },
    template_version: INTELLIGENCE_TEMPLATE_VERSION,
    attempts: log.attempts,
  };
}

export interface RevisionInput {
  text: string;
  mode: GenerationMode;
  classification: Classification;
  assumptions?: string[] | null;
  answers?: Record<string, string> | null;
  acceptedChanges?: string[];
  acceptedKinds?: SuggestionKind[];
  customObjective?: string | null;
  tokenBudget?: number | null;
  targetModel: string;
  provider: IntelligenceProvider;
  preferences: Record<string, unknown>;
  requestId: string;
  userKey: string;
  maxIterations?: number;
}

export interface RevisionResult {
  revised_prompt: string;
  intent: IntentRepresentation;
  template: PromptTemplate;
  report: PreservationReport;
  key_improvements: string[];
  assumptions_introduced: string[];
  clarification_questions: string[];
  iterations: number;
  repaired: boolean;
  /** "local" when no model call was needed. */
  engine: "local" | "model";
  compression_steps: Array<{ key: string; label: string; tokens_saved: number; kept: boolean; reason?: string }>;
  budget: { requested: number | null; met: boolean; explanation: string | null; alternatives: string[] };
  attempts: ProviderAttempt[];
  template_version: string;
}

function essentialLost(report: PreservationReport) {
  return report.checks.filter((c) => c.essential && (c.status === "missing" || c.status === "contradicted"));
}

/**
 * Generate → validate → repair loop (§6–8). Requirement preservation is a hard
 * constraint: drops are fed back for another revision, and if the iteration
 * limit is reached the missing requirements are appended verbatim and flagged.
 */
export async function reviseText(input: RevisionInput): Promise<RevisionResult> {
  const log = new AttemptLog();
  const modelId = input.targetModel;
  const tokens = (t: string) => countTokens(t, modelId).token_count;
  const requirements = extractRequirements(input.text);
  const intent = buildIntent({ text: input.text, classification: input.classification, requirements, assumptions: input.assumptions, answers: input.answers });
  const template = templateFor(intent.task_type);
  const budget = input.tokenBudget && input.tokenBudget > 0 ? Math.round(input.tokenBudget) : null;
  const semantic: SemanticCompare | null =
    input.provider.name === "openai"
      ? async (items, revised) => unwrap(await input.provider.compareRequirements({ items, revised, requestId: input.requestId, userKey: input.userKey }), log).items
      : null;
  const validate = (candidate: string) => validatePreservation(input.text, candidate, { requirements, semantic });
  const compressFor = (candidate: string) => guardedCompress(input.text, candidate, { modelId, budget, requirements });
  const finish = (r: Omit<RevisionResult, "intent" | "template" | "attempts" | "template_version" | "budget"> & { tokensAfter: number }): RevisionResult => {
    const advice = budget ? budgetAdvice(r.tokensAfter, budget, r.report) : { met: true, explanation: null, alternatives: [] };
    const { tokensAfter: _t, ...rest } = r;
    void _t;
    return { ...rest, intent, template, attempts: log.attempts, template_version: INTELLIGENCE_TEMPLATE_VERSION, budget: { requested: budget, ...advice } };
  };

  // Token saver: try the deterministic pipeline first — no model call if it is enough.
  if (input.mode === "token_saver" && !input.acceptedChanges?.length && !Object.keys(input.answers ?? {}).length) {
    const local = await compressFor(input.text);
    const fits = !budget || local.tokens_after <= budget;
    // Safe and within budget: done without a model call, even if nothing could be cut.
    if (fits && essentialLost(local.report).length === 0) {
      const cuts = local.steps.filter((s) => s.kept && s.tokens_saved > 0).map((s) => `${s.label} (${s.tokens_saved} token${s.tokens_saved === 1 ? "" : "s"}).`);
      return finish({
        revised_prompt: local.text,
        report: local.report,
        key_improvements: cuts.length ? cuts : ["Already concise: no reduction was possible without dropping a requirement."],
        assumptions_introduced: [],
        clarification_questions: [],
        iterations: local.iterations,
        repaired: false,
        engine: "local",
        compression_steps: local.steps,
        tokensAfter: local.tokens_after,
      });
    }
  }

  const maxIterations = Math.max(1, Math.min(5, input.maxIterations ?? INTELLIGENCE_CONFIG.maxIterations));
  let restore: string[] = [];
  let best: { text: string; report: PreservationReport; improvements: string[]; assumptions: string[]; questions: string[]; steps: RevisionResult["compression_steps"] } | null = null;
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let output;
    try {
      output = unwrap(
        await input.provider.revisePrompt({
          prompt: input.text,
          mode: input.mode,
          intent,
          template,
          acceptedChanges: input.acceptedChanges ?? [],
          acceptedKinds: input.acceptedKinds ?? [],
          customObjective: input.customObjective ?? null,
          tokenBudget: budget,
          restore,
          preferences: input.preferences,
          questions: input.classification.missing_information.map((m) => ({ key: m.key, question: m.question })),
          requestId: input.requestId,
          userKey: input.userKey,
        }),
        log,
      );
    } catch (error) {
      if (best && error instanceof EngineProviderError) break; // keep the best draft so far
      throw error;
    }
    let candidate = output.revised_prompt;
    let steps: RevisionResult["compression_steps"] = [];
    if (input.mode === "token_saver" || input.mode === "balanced" || budget) {
      const squeezed = await compressFor(candidate);
      candidate = squeezed.text;
      steps = squeezed.steps;
    }
    const report = await validate(candidate);
    const lost = essentialLost(report);
    if (!best || lost.length < essentialLost(best.report).length || (lost.length === essentialLost(best.report).length && (!budget || tokens(candidate) < tokens(best.text)))) {
      best = { text: candidate, report, improvements: output.key_improvements, assumptions: output.assumptions_introduced, questions: output.clarification_questions, steps };
    }
    if (lost.length === 0 && (!budget || tokens(candidate) <= budget)) {
      iterations += 1;
      break;
    }
    restore = lost.map((c) => c.text);
    if (!restore.length) {
      iterations += 1;
      break; // budget unmet but nothing lost: compression already did what is safe
    }
  }
  if (!best) throw new EngineProviderError("invalid_output", "no revision produced", log.attempts);

  let repaired = false;
  const stillLost = essentialLost(best.report);
  if (stillLost.length) {
    const text = `${best.text}\n\nAlso required:\n${stillLost.map((c) => `- ${c.text.replace(/^([-*•]|\d+[.)])\s+/, "")}`).join("\n")}`;
    best = { ...best, text, report: await validate(text), improvements: [...best.improvements, `Re-added ${stillLost.length} requirement${stillLost.length > 1 ? "s" : ""} the rewrite dropped; check the wording.`] };
    repaired = true;
  }
  return finish({
    revised_prompt: best.text,
    report: best.report,
    key_improvements: best.improvements,
    assumptions_introduced: best.assumptions.length ? best.assumptions : best.report.new_assumptions,
    clarification_questions: best.questions,
    iterations,
    repaired,
    engine: "model",
    compression_steps: best.steps,
    tokensAfter: tokens(best.text),
  });
}

/** Classification for a revision when the caller did not run analysis first. */
export function quickClassification(text: string, override?: IntentCategory | null): Classification {
  const rules = classifyByRules(text);
  return override ? withUserCategory(rules, override, text) : rules;
}
