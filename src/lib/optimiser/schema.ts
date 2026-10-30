import { z } from "zod";

import { TASK_CATEGORIES } from "@/lib/categories";

/**
 * Structured optimiser output contract (SRS §7.3). Sent to the provider as a strict
 * JSON schema and re-validated on the way back; model-supplied token estimates are
 * advisory only and are replaced by the server-side tokenizer estimate.
 */
export const optimisationOutputSchema = z.object({
  optimised_prompt: z.string(),
  task_category: z.enum(TASK_CATEGORIES),
  change_summary: z.array(z.string()),
  assumptions: z.array(z.string()),
  clarification_needed: z.boolean(),
  clarifying_questions: z.array(z.string()),
  estimated_input_tokens_before: z.number().int(),
  estimated_input_tokens_after: z.number().int(),
  quality_risks: z.array(z.string()),
});

export type OptimisationOutput = z.infer<typeof optimisationOutputSchema>;

/** Hard limits applied after schema validation so a malformed-but-valid response cannot bloat storage or the UI. */
export const OUTPUT_LIMITS = {
  maxOptimisedChars: 60_000,
  maxListItems: 12,
  maxItemChars: 400,
} as const;

export type OutputValidation =
  | { ok: true; value: OptimisationOutput }
  | { ok: false; reason: string };

/**
 * Validate an untrusted provider payload against the contract and apply bounds.
 * Lists are trimmed rather than rejected; an empty optimised prompt is rejected.
 */
export function validateOptimisationOutput(payload: unknown): OutputValidation {
  const parsed = optimisationOutputSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const value = parsed.data;
  const optimised = value.optimised_prompt.trim();
  if (!optimised && !value.clarification_needed) {
    return { ok: false, reason: "optimised_prompt is empty" };
  }
  if (optimised.length > OUTPUT_LIMITS.maxOptimisedChars) {
    return { ok: false, reason: "optimised_prompt exceeds the maximum length" };
  }
  const bound = (items: string[]) =>
    items
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, OUTPUT_LIMITS.maxListItems)
      .map((s) => (s.length > OUTPUT_LIMITS.maxItemChars ? `${s.slice(0, OUTPUT_LIMITS.maxItemChars - 1)}…` : s));

  return {
    ok: true,
    value: {
      ...value,
      optimised_prompt: optimised,
      change_summary: bound(value.change_summary),
      assumptions: bound(value.assumptions),
      clarifying_questions: bound(value.clarifying_questions),
      quality_risks: bound(value.quality_risks),
      estimated_input_tokens_before: Math.max(0, value.estimated_input_tokens_before),
      estimated_input_tokens_after: Math.max(0, value.estimated_input_tokens_after),
    },
  };
}
