import { INTELLIGENCE_CONFIG, RUBRIC_DIMENSIONS, RUBRIC_LABELS, RUBRIC_WEIGHTS, type RubricDimension } from "@/lib/config/intelligence";

import type { IntentCategory } from "./categories";
import type { MissingInfo } from "./classifier";
import { extractRequirements, FORMAT_CUE, LENGTH_CUE, type Requirement } from "./requirements";
import { clauses, exactValues, wordCount } from "./text";

/**
 * PromptCompletenessScorer (§4): a configurable, transparent heuristic.
 *   quality_score = 100 · Σ wᵢ·sᵢ  (weights normalised over applicable dimensions)
 * It indicates how much a prompt states, not how good the answer will be.
 */
export interface DimensionScore {
  key: RubricDimension;
  label: string;
  /** Configured weight (before normalisation). */
  weight: number;
  /** Weight actually used after normalisation over applicable dimensions (0–1). */
  normalised_weight: number;
  score: number;
  applicable: boolean;
  evidence: string[];
}

export interface CompletenessScore {
  overall: number;
  dimensions: DimensionScore[];
  missing_elements: string[];
  priorities: Array<{ key: RubricDimension; label: string; reason: string }>;
  sufficiently_clear: boolean;
  needs_more_context: boolean;
  explanation: string;
}

export const SCORE_NOTE =
  "A heuristic indicator of how completely the prompt states its goal, context and requirements. It is not a measure or prediction of answer quality.";

const VAGUE = /\b(stuff|things|etc\.?|something|somehow|good|nice|better|some kind of|whatever)\b/gi;
const PURPOSE = /\b(so that|in order to|because|goal is|the aim|purpose|to help|for (?:my|our|a|the)\b)/i;
const CONTEXT_CUES = /\b(i am|i'm|we are|we're|our|my|currently|background|context|audience|users?|customers?|for (?:my|our|a|an|the)\b|for (?:[\w-]+\s){0,2}[\w-]+(?:ers|ees|ents|ists)\b|the (?:company|team|product|project)|existing|already)\b/gi;
const EXAMPLES_PRESENT = /\b(e\.g\.|for example|for instance|such as|like this|example:|sample:)|```|"[^"]{12,}"/i;

/** Tasks where an example of the desired output usually changes the result. */
const EXAMPLES_HELP: IntentCategory[] = ["writing_communication", "marketing_seo", "creative_ideation", "data_analysis"];

const clamp = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

export function scorePrompt(text: string, category: IntentCategory, missing: MissingInfo[], requirements?: Requirement[]): CompletenessScore {
  const reqs = requirements ?? extractRequirements(text);
  const words = wordCount(text);
  const parts = clauses(text).filter((c) => !c.code);
  const kinds = (k: Requirement["kind"][]) => reqs.filter((r) => k.includes(r.kind));
  const dims: Record<RubricDimension, { score: number; evidence: string[]; applicable: boolean }> = {
    objective: { score: 0, evidence: [], applicable: true },
    context: { score: 0, evidence: [], applicable: true },
    specificity: { score: 0, evidence: [], applicable: true },
    constraints: { score: 0, evidence: [], applicable: true },
    output_format: { score: 0, evidence: [], applicable: true },
    examples: { score: 0, evidence: [], applicable: true },
  };

  // Objective clarity
  const objective = reqs.find((r) => r.kind === "objective");
  if (objective) {
    dims.objective.score += 0.5;
    dims.objective.evidence.push("States what to do in the opening instruction.");
    if (objective.terms.length >= 3) {
      dims.objective.score += 0.3;
      dims.objective.evidence.push("Names a specific deliverable.");
    }
  } else {
    dims.objective.evidence.push("No clear instruction (what to produce) was found.");
  }
  if (PURPOSE.test(text)) {
    dims.objective.score += 0.2;
    dims.objective.evidence.push("Explains the purpose or who it is for.");
  }
  if (words < 6) {
    dims.objective.score = Math.min(dims.objective.score, 0.4);
    dims.objective.evidence.push(`Only ${words} word${words === 1 ? "" : "s"}, so the goal is underspecified.`);
  }

  // Context completeness
  const cues = new Set((text.match(CONTEXT_CUES) ?? []).map((c) => c.toLowerCase())).size;
  const extra = Math.max(0, parts.length - 1);
  dims.context.score = Math.min(1, 0.2 * cues + 0.1 * extra);
  dims.context.evidence.push(cues ? `${cues} background detail${cues > 1 ? "s" : ""} (who, what situation).` : "No background about the situation, audience or purpose.");
  const material = missing.length;
  if (material) {
    dims.context.score = Math.max(0, dims.context.score - 0.1 * material);
    dims.context.evidence.push(`Missing for this task: ${missing.map((m) => m.label.toLowerCase()).join(", ")}.`);
  }

  // Instruction specificity
  const specifics = kinds(["functional", "technical", "value", "dependency"]).length;
  const values = exactValues(text).length;
  const vague = text.match(VAGUE)?.length ?? 0;
  // Named things (places, products, dates) make instructions concrete.
  const named = new Set((text.match(/(?<![.!?]\s|^)\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? []).filter((w) => !/^(I|The|This|That|Please|Use|Write|Make)$/.test(w))).size;
  dims.specificity.score = Math.max(0, Math.min(1, 0.2 * specifics + 0.1 * values + 0.1 * Math.min(named, 4) + (objective && objective.terms.length >= 4 ? 0.2 : 0)) - 0.1 * vague);
  dims.specificity.evidence.push(specifics ? `${specifics} specific instruction${specifics > 1 ? "s" : ""}${values ? ` and ${values} concrete value${values > 1 ? "s" : ""}` : ""}.` : "Instructions are general rather than specific.");
  if (vague) dims.specificity.evidence.push(`${vague} vague word${vague > 1 ? "s" : ""} (for example "things", "good").`);

  // Constraints and requirements
  const constraints = kinds(["restriction", "length", "tone", "technical"]).length;
  dims.constraints.score = Math.min(1, 0.35 * constraints);
  dims.constraints.evidence.push(constraints ? `${constraints} constraint${constraints > 1 ? "s" : ""} (limits, tone, technology or exclusions).` : "No limits, exclusions or must-haves are stated.");

  // Output format clarity
  // A clause can carry several cues ("two short paragraphs"), so test the text, not just the label.
  const format = reqs.filter((r) => r.kind === "format" || (r.kind !== "example" && FORMAT_CUE.test(r.text))).length;
  const length = reqs.filter((r) => r.kind === "length" || (r.kind !== "example" && LENGTH_CUE.test(r.text))).length;
  dims.output_format.score = Math.min(1, (format ? 0.6 : 0) + (length ? 0.4 : 0) + (format > 1 ? 0.2 : 0));
  dims.output_format.evidence.push(format || length ? [format ? "Says how the answer should be laid out." : "", length ? "Gives a length." : ""].filter(Boolean).join(" ") : "Doesn't say what form or length the answer should take.");

  // Examples (only when they would help)
  const hasExamples = EXAMPLES_PRESENT.test(text);
  dims.examples.applicable = hasExamples || EXAMPLES_HELP.includes(category);
  if (!dims.examples.applicable) {
    dims.examples.evidence.push("Examples would not materially help this kind of task, so they don't affect the score.");
  } else {
    dims.examples.score = hasExamples ? 1 : 0;
    dims.examples.evidence.push(hasExamples ? "Includes an example or reference material." : "An example of the output you want would help for this kind of task.");
  }

  const applicable = RUBRIC_DIMENSIONS.filter((d) => dims[d].applicable);
  const weightSum = applicable.reduce((n, d) => n + RUBRIC_WEIGHTS[d], 0) || 1;
  const dimensions: DimensionScore[] = RUBRIC_DIMENSIONS.map((d) => ({
    key: d,
    label: RUBRIC_LABELS[d],
    weight: RUBRIC_WEIGHTS[d],
    normalised_weight: dims[d].applicable ? Math.round((RUBRIC_WEIGHTS[d] / weightSum) * 10000) / 10000 : 0,
    score: clamp(dims[d].score),
    applicable: dims[d].applicable,
    evidence: dims[d].evidence,
  }));
  const overall = Math.round(100 * dimensions.reduce((n, d) => n + d.normalised_weight * d.score, 0));

  const priorities = dimensions
    .filter((d) => d.applicable && d.score < 0.75)
    .sort((a, b) => b.normalised_weight * (1 - b.score) - a.normalised_weight * (1 - a.score))
    .slice(0, 3)
    .map((d) => ({ key: d.key, label: d.label, reason: d.evidence[d.evidence.length - 1] ?? "" }));

  const missingElements = [
    ...dimensions.filter((d) => d.applicable && d.score < 0.5).map((d) => d.label),
    ...missing.map((m) => m.label),
  ].filter((v, i, a) => a.indexOf(v) === i);

  const majorGap = dimensions.some((d) => d.applicable && d.weight >= 15 && d.score < 0.4);
  const sufficientlyClear = overall >= INTELLIGENCE_CONFIG.sufficientlyClearScore && !majorGap;
  const needsMoreContext = missing.length > 0 || (dims.context.score < 0.3 && words < 25 && category !== "general");

  return {
    overall,
    dimensions,
    missing_elements: missingElements,
    priorities,
    sufficiently_clear: sufficientlyClear,
    needs_more_context: needsMoreContext,
    explanation: sufficientlyClear
      ? "The prompt already states its goal, requirements and expected output clearly."
      : `Most room to improve: ${priorities.map((p) => p.label.toLowerCase()).join(", ") || "minor wording"}.`,
  };
}
