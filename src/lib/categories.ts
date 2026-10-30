/** Task categories (FR-003). Shared by client and server. */
export const TASK_CATEGORIES = [
  "writing",
  "coding",
  "research",
  "planning",
  "summarisation",
  "extraction",
  "general",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  writing: "Writing",
  coding: "Coding",
  research: "Research",
  planning: "Planning",
  summarisation: "Summarisation",
  extraction: "Extraction",
  general: "General",
};

export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === "string" && (TASK_CATEGORIES as readonly string[]).includes(value);
}

/** Preference keys the optimiser understands (§10.2: unknown keys are ignored). */
export const PREFERENCE_KEYS = [
  "tone",
  "detail",
  "format",
  "audience",
  "language",
  "constraints",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const PREFERENCE_OPTIONS: Record<Exclude<PreferenceKey, "constraints" | "audience" | "language">, readonly string[]> = {
  tone: ["professional_direct", "friendly", "formal", "neutral", "playful"],
  detail: ["concise", "balanced", "detailed"],
  format: ["natural", "structured", "bullet_points", "step_by_step"],
};

export const PREFERENCE_LABELS: Record<PreferenceKey, string> = {
  tone: "Tone",
  detail: "Level of detail",
  format: "Output format",
  audience: "Audience",
  language: "Language",
  constraints: "Standing constraints",
};

export const FEEDBACK_REASON_CODES = [
  "TOO_LONG",
  "TOO_GENERIC",
  "LOST_MEANING",
  "MISSING_CONSTRAINT",
  "WRONG_TONE",
  "CLEARER",
  "MORE_USEFUL",
  "OTHER",
] as const;

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

export const FEEDBACK_REASON_LABELS: Record<FeedbackReasonCode, string> = {
  TOO_LONG: "Too long",
  TOO_GENERIC: "Too generic",
  LOST_MEANING: "Lost meaning",
  MISSING_CONSTRAINT: "Dropped a constraint",
  WRONG_TONE: "Wrong tone",
  CLEARER: "Clearer",
  MORE_USEFUL: "More useful",
  OTHER: "Other",
};
