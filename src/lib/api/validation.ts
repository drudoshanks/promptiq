import { z } from "zod";

import { FEEDBACK_REASON_CODES, PREFERENCE_KEYS, TASK_CATEGORIES } from "@/lib/categories";
import { MAX_EXPECTED_OUTPUT_TOKENS, MAX_TOKEN_COUNT_CHARS, OUTPUT_LENGTH_PRESETS } from "@/lib/config/estimates";
import { HARD_MAX_PROMPT_CHARS } from "@/lib/config/plans";
import { PAYMENT_STATUSES, PROVENANCES } from "@/lib/db/schema";
import { GENERATION_MODES, INTENT_CATEGORIES, SUGGESTION_KINDS } from "@/lib/intelligence/categories";
import { EXPORT_FORMATS } from "@/lib/export";

const taskCategory = z.enum(TASK_CATEGORIES);
const taskCategoryOrAuto = z.enum([...TASK_CATEGORIES, "auto"]);
const uuid = z.uuid();

const preferenceMap = z
  .record(z.string(), z.unknown())
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const out: Record<string, string> = {};
    for (const key of PREFERENCE_KEYS) {
      const v = value[key];
      if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 500);
    }
    return out;
  });

/** POST /api/v1/optimisations (§10.2). Unknown preference keys are dropped. */
export const optimisationRequestSchema = z.object({
  prompt: z.string().max(HARD_MAX_PROMPT_CHARS, "Prompt exceeds the maximum supported length."),
  task_category: taskCategoryOrAuto.default("auto"),
  preferences: preferenceMap,
  options: z
    .object({
      save_to_history: z.boolean().optional(),
      output_style: z.enum(["structured", "natural"]).optional(),
      max_output_tokens: z.number().int().min(300).max(8000).optional(),
      title: z.string().max(120).optional(),
      /** Model the user will run the prompt on (allowlisted server-side). */
      target_model: z.string().min(1).max(100).optional(),
      expected_output: z.lazy(() => expectedOutputSchema).optional(),
    })
    .strict()
    .optional(),
});
export type OptimisationRequest = z.infer<typeof optimisationRequestSchema>;

/** POST /api/v1/optimisations/{id}/feedback (§10.3). */
export const feedbackRequestSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason_code: z.enum(FEEDBACK_REASON_CODES).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
  replace: z.boolean().optional(),
  /** Explicit, user-chosen preference to persist with source=user_confirmed. */
  save_preference: z
    .object({
      category: taskCategory.default("general"),
      preference_key: z.enum(PREFERENCE_KEYS),
      value: z.string().min(1).max(500),
    })
    .nullable()
    .optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

/** POST /api/v1/preferences (§10.4). `source` is ignored and assigned server-side. */
export const createPreferenceSchema = z.object({
  category: taskCategory.default("general"),
  preference_key: z.enum(PREFERENCE_KEYS),
  preference_value: z.record(z.string(), z.unknown()),
  source: z.string().optional(),
});

export const patchPreferenceSchema = z
  .object({
    preference_value: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    category: taskCategory.optional(),
  })
  .refine((v) => v.preference_value !== undefined || v.enabled !== undefined || v.category !== undefined, {
    message: "Provide preference_value, enabled or category.",
  });

export const settingsSchema = z
  .object({
    history_enabled: z.boolean().optional(),
    personalisation_enabled: z.boolean().optional(),
    display_name: z.string().max(80).nullable().optional(),
    onboarded: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one setting." });

const versionInput = z.object({
  prompt_text: z.string().min(1).max(HARD_MAX_PROMPT_CHARS),
  provenance: z.enum(PROVENANCES).default("user_edited"),
  change_summary: z.array(z.string().max(400)).max(12).optional(),
  parent_version_id: uuid.nullable().optional(),
});

export const createPromptSchema = z.object({
  title: z.string().max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  target_model: z.string().max(100).nullable().optional(),
  category: taskCategory.default("general"),
  tags: z.array(z.string().max(30)).max(10).optional(),
  versions: z.array(versionInput).min(1).max(3),
});

export const updatePromptSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    target_model: z.string().max(100).nullable().optional(),
    is_favourite: z.boolean().optional(),
    category: taskCategory.optional(),
    tags: z.array(z.string().max(30)).max(10).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field." });

export const createVersionSchema = versionInput.extend({
  /** Library optimisation that produced this text (links run → version). */
  optimisation_id: uuid.nullable().optional(),
  /** Suggestions incorporated in this text (marked applied). */
  suggestion_ids: z.array(uuid).max(20).optional(),
  provenance: z.enum(PROVENANCES).optional(),
});

export const listPromptsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: taskCategory.optional(),
  tag: z.string().max(30).optional(),
  target_model: z.string().max(100).optional(),
  favourite: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  optimisation: z.enum(["optimised", "not_optimised"]).optional(),
  priority: z.enum(["attention", "high", "medium", "low"]).optional(),
  sort: z.enum(["recent", "oldest", "most_used", "largest", "most_saved", "attention"]).default("recent"),
  archived: z.enum(["include", "only"]).optional(),
  include_archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});

export const exportQuerySchema = z.object({
  format: z.enum(EXPORT_FORMATS).default("txt"),
  version: uuid.optional(),
});

export const deletionRequestSchema = z.object({
  /** The user must retype their email to confirm (UI guard; re-auth is enforced separately). */
  confirm_email: z.string().min(3).max(320),
});

export const idParamSchema = z.object({ id: uuid });

// ---------------------------------------------------------------------------
// Token & cost estimation
// ---------------------------------------------------------------------------
const presetNames = Object.keys(OUTPUT_LENGTH_PRESETS) as [keyof typeof OUTPUT_LENGTH_PRESETS, ...Array<keyof typeof OUTPUT_LENGTH_PRESETS>];

/** A preset name ("short" | "medium" | "long") or a custom token count. */
export const expectedOutputSchema = z.union([z.enum(presetNames), z.number().int().min(0).max(MAX_EXPECTED_OUTPUT_TOKENS)]);

/**
 * Bodies are bounded at twice the counting limit so a request is never parsed
 * unboundedly; between the two limits the tokenizer answers 413 PROMPT_TOO_LONG.
 */
const countableText = z.string().max(MAX_TOKEN_COUNT_CHARS * 2, "Text is too large to count.");

/** POST /api/v1/token-estimates: either `text`, or `original_text` + `optimised_text`. */
export const tokenEstimateRequestSchema = z
  .object({
    model: z.string().min(1).max(100),
    text: countableText.optional(),
    original_text: countableText.optional(),
    optimised_text: countableText.optional(),
    expected_output: expectedOutputSchema.optional(),
    /** Persist this estimate (e.g. the final count before export). Never set while typing. */
    record: z
      .object({
        label: z.enum(["final", "adhoc"]),
        prompt_version_id: uuid.nullable().optional(),
        run_id: uuid.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => (v.text !== undefined) !== (v.original_text !== undefined || v.optimised_text !== undefined), {
    message: "Send either text, or original_text and optimised_text.",
  })
  .refine((v) => v.text !== undefined || (v.original_text !== undefined && v.optimised_text !== undefined), {
    message: "original_text and optimised_text must be sent together.",
  })
  .refine((v) => !v.record || v.text !== undefined, { message: "record is only supported with text." });
export type TokenEstimateRequest = z.infer<typeof tokenEstimateRequestSchema>;

export const usageRecordsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Prompt library: analysis, suggestions, optimisation, preferences
// ---------------------------------------------------------------------------
export const analyseRequestSchema = z
  .object({
    version_id: uuid.nullable().optional(),
    /** Re-analyse even if this version already has a completed analysis. */
    force: z.boolean().optional(),
    /** Manual task category (Prompt Intelligence). */
    category: z.enum(INTENT_CATEGORIES).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Prompt Intelligence (§14)
// ---------------------------------------------------------------------------
const intelligenceSource = {
  /** Unsaved text, or an edited draft of prompt_id. */
  prompt_text: z.string().max(HARD_MAX_PROMPT_CHARS).nullable().optional(),
  prompt_id: uuid.nullable().optional(),
  version_id: uuid.nullable().optional(),
};
const needsSource = (v: { prompt_text?: string | null; prompt_id?: string | null }) => Boolean(v.prompt_text?.trim() || v.prompt_id);
const sourceMessage = { message: "Provide prompt_text or prompt_id." };

export const intelligenceAnalyseSchema = z
  .object({
    ...intelligenceSource,
    category: z.enum(INTENT_CATEGORIES).nullable().optional(),
    target_model: z.string().max(100).nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine(needsSource, sourceMessage);

export const intelligenceReviseSchema = z
  .object({
    ...intelligenceSource,
    mode: z.enum(GENERATION_MODES).optional(),
    category: z.enum(INTENT_CATEGORIES).nullable().optional(),
    target_model: z.string().max(100).nullable().optional(),
    token_budget: z.number().int().min(10).max(200_000).nullable().optional(),
    assumptions: z.array(z.string().max(400)).max(12).nullable().optional(),
    answers: z.record(z.string().max(60), z.string().max(1000)).nullable().optional(),
    suggestion_ids: z.array(uuid).max(12).optional(),
    accepted_changes: z.array(z.object({ category: z.string().max(40), text: z.string().min(1).max(600) }).strict()).max(12).optional(),
    custom_objective: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine(needsSource, sourceMessage)
  .refine((v) => Object.keys(v.answers ?? {}).length <= 12, { message: "Too many answers." });

export const intelligenceValidateSchema = z
  .object({
    original: z.string().min(1).max(HARD_MAX_PROMPT_CHARS),
    revised: z.string().min(1).max(HARD_MAX_PROMPT_CHARS * 3),
    target_model: z.string().max(100).nullable().optional(),
    /** Also run the model-assisted meaning check (uses analysis quota). */
    semantic: z.boolean().optional(),
  })
  .strict();

export const feedbackEventSchema = z
  .object({
    event_type: z.enum(["rated_helpful", "rated_unhelpful", "suggestion_dismissed", "suggestion_deferred"]),
    run_id: uuid.nullable().optional(),
    prompt_id: uuid.nullable().optional(),
    suggestion_category: z.enum(SUGGESTION_KINDS).nullable().optional(),
    task_category: z.enum(INTENT_CATEGORIES).nullable().optional(),
  })
  .strict();

export const suggestionStatusSchema = z.object({ status: z.enum(["pending", "accepted", "dismissed", "deferred"]) }).strict();

export const suggestionsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(["pending", "accepted", "dismissed", "deferred", "applied"])).optional()),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

export const libraryOptimiseSchema = z
  .object({
    version_id: uuid.nullable().optional(),
    /** The user's edited revision (preview) to optimise instead of the stored text. */
    text: z.string().max(HARD_MAX_PROMPT_CHARS).nullable().optional(),
    mode: z.enum(["balanced", "token_saver", "quality_first", "custom"]).optional(),
    custom_objective: z.string().max(500).nullable().optional(),
    suggestion_ids: z.array(uuid).max(12).optional(),
    target_model: z.string().max(100).nullable().optional(),
    expected_output: z.lazy(() => expectedOutputSchema).optional(),
  })
  .strict();

export const archiveSchema = z.object({ archived: z.boolean() }).strict();

export const promptPreferencesSchema = z
  .object({
    preferred_model: z.string().max(100).nullable().optional(),
    preferred_style: z.enum(["natural", "structured", "bullet_points", "step_by_step"]).nullable().optional(),
    preferred_response_length: z.enum(["short", "medium", "long"]).nullable().optional(),
    token_efficiency_priority: z.enum(["low", "balanced", "high"]).optional(),
    default_optimisation_mode: z.enum(["detailed", "balanced", "token_saver", "quality_first"]).optional(),
    domains: z.array(z.string().max(40)).max(10).optional(),
    learn_from_feedback: z.boolean().optional(),
    background_analysis: z.boolean().optional(),
    prompt_style: z.enum(["minimal", "balanced", "comprehensive"]).nullable().optional(),
    task_categories: z.array(z.enum(INTENT_CATEGORIES)).max(11).optional(),
    helpful_suggestion_categories: z.array(z.enum(SUGGESTION_KINDS)).max(10).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one preference." });

export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// UPI payments
// ---------------------------------------------------------------------------
export const createPaymentRequestSchema = z.object({ plan_code: z.string().regex(/^[a-z0-9_]{2,40}$/) }).strict();

export const submitPaymentSchema = z
  .object({
    transaction_reference: z.string().min(1).max(60),
    paid_at: z.iso.datetime({ offset: true, local: true }),
    /** Rupees as shown to the user (e.g. "499.00"); converted to paise server-side. */
    amount: z.union([z.string().max(20), z.number()]),
    notes: z.string().max(1000).nullable().optional(),
  })
  .strict();

export const adminPaymentsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(PAYMENT_STATUSES)).optional()),
  plan: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
  customer: z.string().max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export const verifyPaymentSchema = z
  .object({
    confirmed_independent_check: z.literal(true, { message: "Confirm that you checked the bank statement or UPI merchant app." }),
    verification_notes: z.string().min(5).max(2000),
    verified_amount: z.union([z.string().max(20), z.number()]),
    discrepancy_resolution: z.string().max(1000).nullable().optional(),
    recovery_reason: z.string().max(1000).nullable().optional(),
    transaction_reference: z.string().max(60).nullable().optional(),
  })
  .strict();

export const rejectPaymentSchema = z.object({ reason: z.string().min(10).max(1000) }).strict();
export const requestInformationSchema = z.object({ message: z.string().min(10).max(1000) }).strict();
