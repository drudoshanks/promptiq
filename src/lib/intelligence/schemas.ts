import { z } from "zod";

import { INTENT_CATEGORIES, SUGGESTION_KINDS } from "./categories";

/**
 * Structured contracts for the intelligence pipeline. Model outputs are sent as
 * strict JSON schemas and re-validated here before use; numeric bounds and list
 * sizes are enforced server-side, never trusted to the model.
 */

/** Structured intermediate representation of the user's intent (§5). */
export const intentRepresentationSchema = z.object({
  task_type: z.enum(INTENT_CATEGORIES),
  objective: z.string().min(1).max(400),
  context: z.array(z.string().max(600)).max(20),
  requirements: z.array(z.string().max(600)).max(40),
  constraints: z.array(z.string().max(600)).max(30),
  output_format: z.array(z.string().max(400)).max(10),
  missing_information: z.array(z.string().max(80)).max(12),
  assumptions: z.array(z.string().max(400)).max(12),
  must_preserve: z.array(z.string().max(600)).max(40),
});
export type IntentRepresentation = z.infer<typeof intentRepresentationSchema>;

/** Model output: classification + suggestions + requirement extraction (one call). */
export const modelAnalysisSchema = z.object({
  primary_category: z.enum(INTENT_CATEGORIES),
  secondary_category: z.enum(INTENT_CATEGORIES).nullable(),
  objective: z.string(),
  confidence: z.number(),
  missing_information: z.array(z.object({ key: z.string(), label: z.string(), question: z.string() })),
  requirements: z.array(z.object({ text: z.string(), essential: z.boolean() })),
  suggestions: z.array(
    z.object({
      category: z.enum(SUGGESTION_KINDS),
      priority: z.enum(["high", "medium", "low"]),
      title: z.string(),
      explanation: z.string(),
      recommended_change: z.string(),
      expected_benefit: z.string(),
      token_direction: z.enum(["reduce", "increase", "neutral"]),
      requires_clarification: z.boolean(),
      clarification_question: z.string().nullable(),
    }),
  ),
  already_well_optimised: z.boolean(),
});
export type ModelAnalysis = z.infer<typeof modelAnalysisSchema>;

/** Model output for a revision. */
export const modelRevisionSchema = z.object({
  revised_prompt: z.string(),
  key_improvements: z.array(z.string()),
  assumptions_introduced: z.array(z.string()),
  clarification_questions: z.array(z.string()),
});
export type ModelRevision = z.infer<typeof modelRevisionSchema>;

/** Model output for the semantic preservation check. */
export const modelComparisonSchema = z.object({
  items: z.array(z.object({ id: z.string(), status: z.enum(["preserved", "changed", "missing", "contradicted"]), note: z.string().nullable() })),
});
export type ModelComparison = z.infer<typeof modelComparisonSchema>;

type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const clip = (s: string, max: number) => {
  const t = s.trim().replace(/[ \t]+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const reason = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export function validateModelAnalysis(payload: unknown): Validation<ModelAnalysis> {
  const p = modelAnalysisSchema.safeParse(payload);
  if (!p.success) return { ok: false, reason: reason(p.error) };
  const v = p.data;
  if (!Number.isFinite(v.confidence)) return { ok: false, reason: "confidence is not a number" };
  const seen = new Set<string>();
  return {
    ok: true,
    value: {
      ...v,
      objective: clip(v.objective, 300),
      confidence: Math.max(0, Math.min(1, v.confidence > 1 ? v.confidence / 100 : v.confidence)),
      missing_information: v.missing_information.slice(0, 8).map((m) => ({ key: clip(m.key, 60).toLowerCase().replace(/[^a-z0-9_]+/g, "_"), label: clip(m.label, 80), question: clip(m.question, 240) })),
      requirements: v.requirements.filter((r) => r.text.trim()).slice(0, 30).map((r) => ({ text: clip(r.text, 400), essential: r.essential })),
      suggestions: v.suggestions
        .map((s) => ({
          ...s,
          title: clip(s.title, 120),
          explanation: clip(s.explanation, 600),
          recommended_change: clip(s.recommended_change, 600),
          expected_benefit: clip(s.expected_benefit, 300),
          clarification_question: s.requires_clarification && s.clarification_question?.trim() ? clip(s.clarification_question, 300) : null,
        }))
        .filter((s) => s.title && s.recommended_change)
        .filter((s) => {
          const k = `${s.category}:${s.title.toLowerCase()}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 8),
    },
  };
}

export function validateModelRevision(payload: unknown): Validation<ModelRevision> {
  const p = modelRevisionSchema.safeParse(payload);
  if (!p.success) return { ok: false, reason: reason(p.error) };
  const v = p.data;
  if (!v.revised_prompt.trim()) return { ok: false, reason: "revised_prompt is empty" };
  if (v.revised_prompt.length > 60_000) return { ok: false, reason: "revised_prompt is too long" };
  return {
    ok: true,
    value: {
      revised_prompt: v.revised_prompt.trim(),
      key_improvements: v.key_improvements.map((s) => clip(s, 240)).filter(Boolean).slice(0, 8),
      assumptions_introduced: v.assumptions_introduced.map((s) => clip(s, 240)).filter(Boolean).slice(0, 10),
      clarification_questions: v.clarification_questions.map((s) => clip(s, 240)).filter(Boolean).slice(0, 6),
    },
  };
}

export function validateModelComparison(payload: unknown): Validation<ModelComparison> {
  const p = modelComparisonSchema.safeParse(payload);
  if (!p.success) return { ok: false, reason: reason(p.error) };
  return { ok: true, value: { items: p.data.items.slice(0, 60).map((i) => ({ ...i, note: i.note ? clip(i.note, 240) : null })) } };
}
