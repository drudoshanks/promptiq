import { RANKING_PRIOR, RANKING_WEIGHTS } from "@/lib/config/intelligence";

import { TOKEN_KINDS, type IntentCategory, type SuggestionKind } from "./categories";

/**
 * FeedbackRankingService (§10). A transparent weighted model:
 *   recommendation_score = w₁·acceptance + w₂·preference_match + w₃·task_relevance
 * Each component is in [0, 1]; weights are normalised. Acceptance is smoothed
 * toward a neutral prior and blended by volume, so a few clicks never become
 * a permanent preference.
 */
export interface FeedbackCounts {
  accepted: number;
  dismissed: number;
}

export interface RankingContext {
  /** Accept/dismiss counts per suggestion kind (all tasks). */
  byKind: Partial<Record<SuggestionKind, FeedbackCounts>>;
  /** Accept/dismiss counts per suggestion kind within the current task category. */
  byKindForTask?: Partial<Record<SuggestionKind, FeedbackCounts>>;
  preferences: {
    tokenEfficiencyPriority: "low" | "balanced" | "high";
    helpfulCategories: string[];
    preferredOutputFormat: string | null;
    promptStyle: "minimal" | "balanced" | "comprehensive" | null;
  };
  learnFromFeedback: boolean;
}

export interface RankingBreakdown {
  score: number;
  acceptance: number;
  preference_match: number;
  task_relevance: number;
  feedback_events: number;
  explanation: string;
}

/** Beta-smoothed acceptance, blended toward the prior until enough events exist. */
export function acceptanceRate(counts: FeedbackCounts | undefined): { rate: number; events: number } {
  const events = (counts?.accepted ?? 0) + (counts?.dismissed ?? 0);
  if (!counts || events === 0) return { rate: RANKING_PRIOR.rate, events: 0 };
  const alpha = RANKING_PRIOR.rate * RANKING_PRIOR.strength;
  const smoothed = (counts.accepted + alpha) / (events + RANKING_PRIOR.strength);
  const confidence = Math.min(1, events / RANKING_PRIOR.fullConfidenceAt);
  return { rate: RANKING_PRIOR.rate + confidence * (smoothed - RANKING_PRIOR.rate), events };
}

/** How relevant each suggestion kind usually is for a task category (0–1). */
const RELEVANCE: Partial<Record<IntentCategory, Partial<Record<SuggestionKind, number>>>> = {
  software_development: { task_specific: 1, specificity: 0.9, constraints: 0.9, output_format: 0.7, examples: 0.5, missing_context: 0.8 },
  writing_communication: { missing_context: 0.9, output_format: 0.9, examples: 0.8, constraints: 0.7, task_specific: 0.8 },
  research_analysis: { task_specific: 0.9, specificity: 0.9, output_format: 0.8, constraints: 0.7 },
  business_strategy: { missing_context: 1, task_specific: 0.9, specificity: 0.8, output_format: 0.7 },
  marketing_seo: { missing_context: 0.9, examples: 0.8, task_specific: 0.9, output_format: 0.8 },
  data_analysis: { task_specific: 1, specificity: 0.9, output_format: 0.8, examples: 0.7 },
  creative_ideation: { examples: 0.8, constraints: 0.6, missing_context: 0.7, specificity: 0.6 },
  project_planning: { task_specific: 0.9, specificity: 0.8, output_format: 0.8, constraints: 0.7 },
};
const ALWAYS_RELEVANT: Partial<Record<SuggestionKind, number>> = { contradictions: 1, clarity: 0.9 };

export function taskRelevance(kind: SuggestionKind, category: IntentCategory): number {
  return ALWAYS_RELEVANT[kind] ?? RELEVANCE[category]?.[kind] ?? 0.6;
}

export function preferenceMatch(kind: SuggestionKind, prefs: RankingContext["preferences"]): number {
  if (prefs.helpfulCategories.includes(kind)) return 1;
  if (TOKEN_KINDS.includes(kind)) return prefs.tokenEfficiencyPriority === "high" ? 1 : prefs.tokenEfficiencyPriority === "low" ? 0.2 : 0.5;
  if (kind === "output_format" && prefs.preferredOutputFormat) return 0.8;
  if ((kind === "missing_context" || kind === "specificity" || kind === "task_specific") && prefs.promptStyle === "comprehensive") return 0.8;
  if ((kind === "missing_context" || kind === "examples") && prefs.promptStyle === "minimal") return 0.3;
  return 0.5;
}

export function rankSuggestion(kind: SuggestionKind, category: IntentCategory, ctx: RankingContext): RankingBreakdown {
  const taskCounts = ctx.byKindForTask?.[kind];
  const useTask = taskCounts && taskCounts.accepted + taskCounts.dismissed >= 3;
  const acc = ctx.learnFromFeedback ? acceptanceRate(useTask ? taskCounts : ctx.byKind[kind]) : { rate: RANKING_PRIOR.rate, events: 0 };
  const pref = preferenceMatch(kind, ctx.preferences);
  const rel = taskRelevance(kind, category);
  const wSum = RANKING_WEIGHTS.acceptance + RANKING_WEIGHTS.preference + RANKING_WEIGHTS.relevance;
  const score = (RANKING_WEIGHTS.acceptance * acc.rate + RANKING_WEIGHTS.preference * pref + RANKING_WEIGHTS.relevance * rel) / wSum;
  const parts: string[] = [];
  if (acc.events >= RANKING_PRIOR.fullConfidenceAt) parts.push(`you accepted about ${Math.round(acc.rate * 100)}% of ${acc.events} similar suggestions`);
  else if (acc.events > 0) parts.push(`${acc.events} earlier decision${acc.events === 1 ? "" : "s"} on similar suggestions, weighed lightly until there are more`);
  else parts.push(ctx.learnFromFeedback ? "no feedback on this kind yet" : "feedback learning is off");
  if (pref >= 0.8) parts.push("matches your preferences");
  if (rel >= 0.9) parts.push("usually matters for this kind of task");
  return {
    score: Math.round(score * 1000) / 1000,
    acceptance: Math.round(acc.rate * 1000) / 1000,
    preference_match: pref,
    task_relevance: rel,
    feedback_events: acc.events,
    explanation: parts.join("; "),
  };
}

const PRIORITY_VALUE = { high: 1, medium: 0.6, low: 0.3 } as const;

/** Final order: half intrinsic priority, half personal recommendation score. */
export function orderingKey(priority: keyof typeof PRIORITY_VALUE, recommendation: number): number {
  return 0.5 * PRIORITY_VALUE[priority] + 0.5 * recommendation;
}
