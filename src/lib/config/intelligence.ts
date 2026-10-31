/**
 * Prompt Intelligence configuration. Every tunable number of the engine lives
 * here so it can be reviewed and changed in one place. These are heuristics,
 * not established measures of prompt effectiveness.
 */

export const RUBRIC_DIMENSIONS = ["objective", "context", "specificity", "constraints", "output_format", "examples"] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** Initial rubric weights (normalised to sum to 1 before scoring). */
export const RUBRIC_WEIGHTS: Record<RubricDimension, number> = {
  objective: 25,
  context: 20,
  specificity: 20,
  constraints: 15,
  output_format: 15,
  examples: 5,
};

export const RUBRIC_LABELS: Record<RubricDimension, string> = {
  objective: "Objective clarity",
  context: "Context completeness",
  specificity: "Instruction specificity",
  constraints: "Constraints and requirements",
  output_format: "Output format clarity",
  examples: "Examples or references",
};

export const INTELLIGENCE_CONFIG = {
  /** Rule-based classification at or above this confidence skips the model. */
  ruleConfidenceThreshold: 0.6,
  /** A score at or above this (with no high-priority gaps) is "sufficiently clear". */
  sufficientlyClearScore: 70,
  /** Maximum generate → validate → repair rounds per revision. */
  maxIterations: 3,
  /** Maximum suggestions shown for one analysis. */
  maxSuggestions: 8,
  /** Requirements extracted per prompt (bounded so validation stays cheap). */
  maxRequirements: 40,
  /** Key-term overlap at or above this counts a requirement as preserved. */
  preservedOverlap: 0.75,
  /** Overlap between this and preservedOverlap counts as changed/ambiguous. */
  changedOverlap: 0.4,
  /** Ad-hoc (unsaved) analysis cache lifetime. */
  adhocCacheMs: 10 * 60 * 1000,
} as const;

/**
 * Feedback ranking: recommendation_score = w1·acceptance + w2·preference + w3·relevance.
 * Weights are normalised; acceptance is smoothed toward a neutral prior so a
 * handful of clicks never becomes a permanent preference.
 */
export const RANKING_WEIGHTS = { acceptance: 0.45, preference: 0.3, relevance: 0.25 } as const;
export const RANKING_PRIOR = {
  /** Neutral acceptance rate assumed before any feedback. */
  rate: 0.5,
  /** Pseudo-observations behind the prior (Beta(α, β) with α+β = strength). */
  strength: 4,
  /** Feedback events needed before history carries its full weight. */
  fullConfidenceAt: 10,
} as const;
