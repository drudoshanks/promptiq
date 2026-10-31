import type { TaskCategory } from "@/lib/categories";

/** Intent categories of the Prompt Intelligence Engine (§3). Shared by client and server. */
export const INTENT_CATEGORIES = [
  "software_development",
  "writing_communication",
  "research_analysis",
  "business_strategy",
  "marketing_seo",
  "data_analysis",
  "education_tutoring",
  "creative_ideation",
  "project_planning",
  "general",
  "unknown",
] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export const INTENT_LABELS: Record<IntentCategory, string> = {
  software_development: "Software development",
  writing_communication: "Writing and communication",
  research_analysis: "Research and analysis",
  business_strategy: "Business strategy",
  marketing_seo: "Marketing and SEO",
  data_analysis: "Data analysis",
  education_tutoring: "Education and tutoring",
  creative_ideation: "Creative writing and ideation",
  project_planning: "Project planning",
  general: "General task",
  unknown: "Not sure yet",
};

export function isIntentCategory(value: unknown): value is IntentCategory {
  return typeof value === "string" && (INTENT_CATEGORIES as readonly string[]).includes(value);
}

/** Map to the library's coarser task category (stored on prompts and runs). */
export const TO_TASK_CATEGORY: Record<IntentCategory, TaskCategory> = {
  software_development: "coding",
  writing_communication: "writing",
  research_analysis: "research",
  business_strategy: "planning",
  marketing_seo: "writing",
  data_analysis: "extraction",
  education_tutoring: "general",
  creative_ideation: "writing",
  project_planning: "planning",
  general: "general",
  unknown: "general",
};

/** Suggestion categories (§9). */
export const SUGGESTION_KINDS = [
  "clarity",
  "missing_context",
  "specificity",
  "output_format",
  "constraints",
  "redundancy",
  "token_efficiency",
  "contradictions",
  "examples",
  "task_specific",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_KIND_LABELS: Record<SuggestionKind, string> = {
  clarity: "Clarity",
  missing_context: "Missing context",
  specificity: "Specificity",
  output_format: "Output format",
  constraints: "Constraints",
  redundancy: "Redundancy",
  token_efficiency: "Token efficiency",
  contradictions: "Contradictions",
  examples: "Examples and references",
  task_specific: "Task-specific requirements",
};

export function isSuggestionKind(value: unknown): value is SuggestionKind {
  return typeof value === "string" && (SUGGESTION_KINDS as readonly string[]).includes(value);
}

/** Categories stored by the first library release, mapped to the current set. */
export const LEGACY_SUGGESTION_KINDS: Record<string, SuggestionKind> = {
  ambiguity: "clarity",
  repetition: "redundancy",
  verbosity: "token_efficiency",
  conflicting_constraints: "contradictions",
  role_audience: "missing_context",
  model_suitability: "task_specific",
};

export function toSuggestionKind(value: string): SuggestionKind {
  return isSuggestionKind(value) ? value : (LEGACY_SUGGESTION_KINDS[value] ?? "clarity");
}

/** Suggestion kinds that usually reduce tokens. */
export const TOKEN_KINDS: readonly SuggestionKind[] = ["redundancy", "token_efficiency"];

/** Generation modes (§6). */
export const GENERATION_MODES = ["detailed", "balanced", "token_saver", "quality_first", "custom"] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const GENERATION_MODE_LABELS: Record<GenerationMode, { label: string; description: string }> = {
  detailed: { label: "Detailed", description: "Expand into a complete, structured brief." },
  balanced: { label: "Balanced", description: "Clearer and more complete, without padding." },
  token_saver: { label: "Token saver", description: "As short as possible, keeping every requirement." },
  quality_first: { label: "Quality first", description: "Clarity and reliability over length." },
  custom: { label: "Custom", description: "Optimise for an objective you describe." },
};
