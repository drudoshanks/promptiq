import { z } from "zod";

/**
 * Structured output contract for prompt analysis (Prompt Library §5). Sent to
 * the provider as a strict JSON schema and re-validated server-side before
 * anything is stored or shown. Numeric bounds are enforced here, not trusted to
 * the model.
 */
export const SUGGESTION_CATEGORIES = [
  "clarity",
  "specificity",
  "missing_context",
  "ambiguity",
  "repetition",
  "verbosity",
  "output_format",
  "conflicting_constraints",
  "role_audience",
  "token_efficiency",
  "model_suitability",
] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

export const SUGGESTION_CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  clarity: "Clarity of the goal",
  specificity: "Specific instructions",
  missing_context: "Missing context",
  ambiguity: "Ambiguous wording",
  repetition: "Repetition",
  verbosity: "Verbosity",
  output_format: "Output format",
  conflicting_constraints: "Conflicting constraints",
  role_audience: "Role or audience",
  token_efficiency: "Token efficiency",
  model_suitability: "Fit for the target model",
};

/** Categories whose suggestions usually reduce tokens. */
export const TOKEN_CATEGORIES: readonly SuggestionCategory[] = ["repetition", "verbosity", "token_efficiency"];

export const analysisSuggestionSchema = z.object({
  category: z.enum(SUGGESTION_CATEGORIES),
  priority: z.enum(["high", "medium", "low"]),
  title: z.string(),
  explanation: z.string(),
  recommendation: z.string(),
  estimated_token_impact: z.enum(["none", "low", "medium", "high"]),
  token_direction: z.enum(["reduce", "increase", "neutral"]),
  requires_user_context: z.boolean(),
  context_question: z.string().nullable(),
});

export const analysisOutputSchema = z.object({
  overall_quality_score: z.number(),
  already_well_optimised: z.boolean(),
  summary: z.string(),
  suggestions: z.array(analysisSuggestionSchema),
  recommended_actions: z.array(z.string()),
});

export type AnalysisSuggestion = z.infer<typeof analysisSuggestionSchema>;
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export const ANALYSIS_LIMITS = {
  maxSuggestions: 8,
  maxTitle: 120,
  maxText: 600,
  maxActions: 6,
} as const;

const clip = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export type AnalysisValidation = { ok: true; value: AnalysisOutput } | { ok: false; reason: string };

/**
 * Validate untrusted analysis output: schema, bounds, de-duplication. An
 * analysis with no remaining suggestions is reported as "already well
 * optimised" so the UI never shows an empty, unexplained result.
 */
export function validateAnalysisOutput(payload: unknown): AnalysisValidation {
  const parsed = analysisOutputSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const v = parsed.data;
  if (!Number.isFinite(v.overall_quality_score)) return { ok: false, reason: "overall_quality_score is not a number" };

  const seen = new Set<string>();
  const suggestions = v.suggestions
    .map((s) => ({
      ...s,
      title: clip(s.title, ANALYSIS_LIMITS.maxTitle),
      explanation: clip(s.explanation, ANALYSIS_LIMITS.maxText),
      recommendation: clip(s.recommendation, ANALYSIS_LIMITS.maxText),
      context_question: s.requires_user_context && s.context_question?.trim() ? clip(s.context_question, ANALYSIS_LIMITS.maxText) : null,
    }))
    .filter((s) => s.title && s.recommendation)
    .filter((s) => {
      const key = `${s.category}:${s.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, ANALYSIS_LIMITS.maxSuggestions);

  return {
    ok: true,
    value: {
      overall_quality_score: Math.max(0, Math.min(100, Math.round(v.overall_quality_score))),
      already_well_optimised: v.already_well_optimised || suggestions.length === 0,
      summary: clip(v.summary, ANALYSIS_LIMITS.maxText),
      suggestions,
      recommended_actions: v.recommended_actions.map((a) => clip(a, ANALYSIS_LIMITS.maxTitle)).filter(Boolean).slice(0, ANALYSIS_LIMITS.maxActions),
    },
  };
}
