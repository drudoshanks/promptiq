import { z } from "zod";

import { FEEDBACK_REASON_CODES, PREFERENCE_KEYS, TASK_CATEGORIES } from "@/lib/categories";
import { HARD_MAX_PROMPT_CHARS } from "@/lib/config/plans";
import { PROVENANCES } from "@/lib/db/schema";
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
  category: taskCategory.default("general"),
  tags: z.array(z.string().max(30)).max(10).optional(),
  versions: z.array(versionInput).min(1).max(3),
});

export const updatePromptSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    category: taskCategory.optional(),
    tags: z.array(z.string().max(30)).max(10).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field." });

export const createVersionSchema = versionInput;

export const listPromptsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: taskCategory.optional(),
  tag: z.string().max(30).optional(),
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
