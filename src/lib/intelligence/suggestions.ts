import { INTELLIGENCE_CONFIG } from "@/lib/config/intelligence";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { countTokens } from "@/lib/tokens";

import { SUGGESTION_KIND_LABELS, type IntentCategory, type SuggestionKind } from "./categories";
import type { Classification } from "./classifier";
import { STEPS } from "./compress";
import { orderingKey, rankSuggestion, type RankingBreakdown, type RankingContext } from "./ranking";
import type { ModelAnalysis } from "./schemas";
import type { CompletenessScore } from "./scorer";
import { normaliseSentence, shortHash } from "./text";

/**
 * PromptSuggestionEngine (§9). Deterministic suggestions come from the score,
 * missing information, redundancy and contradiction checks; model suggestions
 * (when available) are merged in. Everything is ranked by the user's feedback
 * model. No suggestion is invented to fill space: a clear prompt gets
 * "Already well optimised".
 */
export type Priority = "high" | "medium" | "low";

export interface EngineSuggestion {
  id: string;
  category: SuggestionKind;
  category_label: string;
  priority: Priority;
  title: string;
  explanation: string;
  recommended_change: string;
  expected_benefit: string;
  /** Signed token change if applied; negative saves tokens. Null when not measurable. */
  estimated_token_impact: number | null;
  token_direction: "reduce" | "increase" | "neutral";
  requires_clarification: boolean;
  clarification_question: string | null;
  source: "rules" | "model";
  ranking: RankingBreakdown;
}

type Draft = Omit<EngineSuggestion, "id" | "category_label" | "ranking">;

const INJECTION = /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|your|system)\b.{0,20}\b(instructions?|rules|prompt)\b|\breveal\b.{0,20}\b(system prompt|instructions)\b|\byou are now\b|\brate this (prompt )?(100|10\/10|perfect)/i;

function duplicates(text: string): string[] {
  const seen = new Map<string, number>();
  const dups: string[] = [];
  for (const s of text.split(/(?<=[.!?])\s+|\n/)) {
    const key = normaliseSentence(s);
    if (key.split(" ").length < 3) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) dups.push(s.trim());
  }
  return dups;
}

function contradictions(text: string): string[] {
  const out: string[] = [];
  if (/\b(short|brief|concise)\b/i.test(text) && /\b(detailed|thorough|comprehensive|in-depth)\b/i.test(text)) out.push("asks for both a brief and a detailed answer");
  if (/\bformal\b/i.test(text) && /\b(casual|informal|playful|chatty)\b/i.test(text)) out.push("asks for both a formal and a casual tone");
  const max = text.match(/\b(?:under|at most|no more than|max(?:imum)?(?: of)?)\s+(\d+)\s+words\b/i);
  const min = text.match(/\b(?:at least|min(?:imum)?(?: of)?)\s+(\d+)\s+words\b/i);
  if (max?.[1] && min?.[1] && Number(min[1]) > Number(max[1])) out.push(`sets a minimum of ${min[1]} words but a maximum of ${max[1]}`);
  return out;
}

function tokenDelta(before: string, after: string, modelId: string): number {
  return countTokens(after, modelId).token_count - countTokens(before, modelId).token_count;
}

export function ruleSuggestions(text: string, c: Classification, score: CompletenessScore, modelId = DEFAULT_TARGET_MODEL): Draft[] {
  const out: Draft[] = [];
  const dim = (k: string) => score.dimensions.find((d) => d.key === k);
  const add = (d: Omit<Draft, "source" | "token_direction" | "estimated_token_impact" | "requires_clarification" | "clarification_question"> & Partial<Draft>) =>
    out.push({ source: "rules", token_direction: "increase", estimated_token_impact: null, requires_clarification: false, clarification_question: null, ...d });

  if (INJECTION.test(text)) {
    add({ category: "clarity", priority: "high", title: "Remove the embedded instruction", explanation: "Part of the prompt tries to change how the assistant or this tool behaves (for example \"ignore previous instructions\"). PromptIQ treats it as text, but it may confuse the model you send the prompt to.", recommended_change: "Delete the embedded instruction and keep only the task you want done.", expected_benefit: "Predictable behaviour and no accidental instruction overrides.", token_direction: "reduce" });
  }
  for (const issue of contradictions(text)) {
    add({ category: "contradictions", priority: "high", title: "Resolve conflicting instructions", explanation: `The prompt ${issue}, so the model has to guess which one wins.`, recommended_change: "Keep one, or say which part each instruction applies to.", expected_benefit: "Consistent output that meets the instruction you actually care about.", token_direction: "neutral", requires_clarification: true, clarification_question: "Which of the conflicting instructions should take priority?" });
  }
  const objective = dim("objective");
  if (objective && objective.score < 0.6) {
    add({ category: "clarity", priority: "high", title: "State the goal and deliverable", explanation: objective.evidence.join(" "), recommended_change: "Start with one sentence saying exactly what you want produced and what it is for.", expected_benefit: "The model spends its answer on the right task instead of guessing.", requires_clarification: true, clarification_question: "What exactly should the answer be, and what will you use it for?" });
  }
  const material = c.missing_information;
  if (material.length) {
    // On an otherwise clear prompt, one missing detail is polish, not a problem.
    add({ category: "task_specific", priority: score.sufficiently_clear ? "low" : material.length >= 2 ? "high" : "medium", title: `Add ${material.slice(0, 3).map((m) => m.label.toLowerCase()).join(", ")}${material.length > 3 ? " and more" : ""}`, explanation: `For ${c.primary === "general" || c.primary === "unknown" ? "this task" : "this kind of task"} these details change the result, and the prompt doesn't state them.`, recommended_change: material.map((m) => m.question).join(" "), expected_benefit: "Fewer assumptions, so the answer fits your situation.", requires_clarification: true, clarification_question: material[0]?.question ?? null });
  }
  const context = dim("context");
  if (context && context.score < 0.4 && !material.length) {
    add({ category: "missing_context", priority: "medium", title: "Give some background", explanation: "The prompt says what to do but not the situation, audience or purpose behind it.", recommended_change: "Add one or two sentences on who this is for and why you need it.", expected_benefit: "Answers pitched at the right level for the right reader.", requires_clarification: true, clarification_question: "Who is this for, and what situation is it part of?" });
  }
  const specificity = dim("specificity");
  if (specificity && specificity.score < 0.5) {
    add({ category: "specificity", priority: "medium", title: "Be specific about what to include", explanation: specificity.evidence.join(" "), recommended_change: "List the points, features or questions the answer must cover, and replace vague words with concrete ones.", expected_benefit: "Answers that cover what you need without filler." });
  }
  const format = dim("output_format");
  if (format && format.score < 0.5) {
    add({ category: "output_format", priority: "medium", title: "Say what form the answer should take", explanation: format.evidence.join(" "), recommended_change: "Add the format and length, for example \"5 bullet points\", \"a table with columns X and Y\" or \"under 200 words\".", expected_benefit: "Output you can use directly, with less reformatting." });
  }
  const constraints = dim("constraints");
  if (constraints && constraints.score < 0.35 && objective && objective.score >= 0.5) {
    add({ category: "constraints", priority: "low", title: "Add limits or must-haves", explanation: constraints.evidence.join(" "), recommended_change: "State anything to avoid, required tools or standards, and the tone or audience level.", expected_benefit: "Fewer revisions to remove things you didn't want." });
  }
  const examples = dim("examples");
  if (examples && examples.applicable && examples.score === 0) {
    add({ category: "examples", priority: "low", title: "Show an example of what you want", explanation: "For this kind of task, a short sample of the style or structure you like guides the model better than a description.", recommended_change: "Paste a short example of the output style you want, labelled as an example.", expected_benefit: "Closer match to the style you have in mind." });
  }
  const dups = duplicates(text);
  if (dups.length) {
    const deduped = STEPS.find((s) => s.key === "dedupe")!.apply(text);
    add({ category: "redundancy", priority: "medium", title: "Remove repeated instructions", explanation: `${dups.length} instruction${dups.length > 1 ? "s appear" : " appears"} more than once, for example "${dups[0]!.slice(0, 80)}".`, recommended_change: "Keep each instruction once.", expected_benefit: "Shorter prompt with exactly the same requirements.", token_direction: "reduce", estimated_token_impact: tokenDelta(text, deduped, modelId) });
  }
  const filler = STEPS.find((s) => s.key === "filler")!.apply(text);
  const verbose = STEPS.find((s) => s.key === "verbose")!.apply(filler);
  const fillerDelta = tokenDelta(text, verbose, modelId);
  if (fillerDelta <= -3) {
    add({ category: "token_efficiency", priority: "low", title: "Cut filler and wordy phrases", explanation: "Phrases like \"could you please\" or \"in order to\" add tokens without adding instructions.", recommended_change: "Write instructions directly (\"Write…\", \"List…\") and use the shorter phrase.", expected_benefit: "Lower cost per run with the same meaning.", token_direction: "reduce", estimated_token_impact: fillerDelta });
  }
  return out;
}

/** Merge rule and model suggestions, rank them, and cap the list. */
export function buildSuggestions(input: {
  text: string;
  classification: Classification;
  score: CompletenessScore;
  model?: ModelAnalysis | null;
  ranking: RankingContext;
  modelId?: string;
  versionKey: string;
}): { suggestions: EngineSuggestion[]; already_well_optimised: boolean } {
  const drafts = ruleSuggestions(input.text, input.classification, input.score, input.modelId);
  for (const m of input.model?.suggestions ?? []) {
    // A model suggestion of a kind the rules already raised refines it only if more severe.
    const existing = drafts.find((d) => d.category === m.category);
    if (existing) continue;
    drafts.push({
      category: m.category,
      priority: m.priority,
      title: m.title,
      explanation: m.explanation,
      recommended_change: m.recommended_change,
      expected_benefit: m.expected_benefit,
      token_direction: m.token_direction,
      estimated_token_impact: null,
      requires_clarification: m.requires_clarification,
      clarification_question: m.clarification_question,
      source: "model",
    });
  }
  const category: IntentCategory = input.classification.primary;
  const ranked = drafts
    .map((d) => ({ ...d, id: `s_${shortHash(`${input.versionKey}:${d.category}:${d.title}`)}`, category_label: SUGGESTION_KIND_LABELS[d.category], ranking: rankSuggestion(d.category, category, input.ranking) }))
    .sort((a, b) => orderingKey(b.priority, b.ranking.score) - orderingKey(a.priority, a.ranking.score))
    .slice(0, INTELLIGENCE_CONFIG.maxSuggestions);

  // Only polish-level suggestions on a clear prompt: report it as well optimised.
  const clear = input.score.sufficiently_clear && ranked.every((s) => s.priority === "low");
  return { suggestions: clear ? ranked.filter((s) => s.estimated_token_impact !== null && s.estimated_token_impact <= -5) : ranked, already_well_optimised: clear || ranked.length === 0 };
}
