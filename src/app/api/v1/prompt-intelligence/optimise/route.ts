import { created, parseJson, withApi } from "@/lib/api/handler";
import { intelligenceReviseSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getPromptPreferences } from "@/lib/services/prompt-preferences";
import { reviseForUser } from "@/lib/services/intelligence";

import { intelligenceContext, sourceOf } from "../_context";

/**
 * POST /api/v1/prompt-intelligence/optimise — token-aware optimisation (default: the user's preferred mode) with an optional token budget.
 * Returns a proposal only: nothing is saved until the user saves it as a version.
 */
export const POST = withApi({ auth: "required", rateLimit: "revisePerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, intelligenceReviseSchema);
  const mode = body.mode ?? (await getPromptPreferences(db, user.id)).defaultOptimisationMode;
  const result = await reviseForUser(intelligenceContext(user, requestId, log), {
    source: sourceOf(body),
    mode,
    category: body.category ?? null,
    targetModel: body.target_model ?? null,
    tokenBudget: body.token_budget ?? null,
    assumptions: body.assumptions ?? null,
    answers: body.answers ?? null,
    suggestionIds: body.suggestion_ids,
    acceptedChanges: body.accepted_changes,
    customObjective: body.custom_objective ?? null,
    autoSave: body.auto_save,
  });
  return created(result);
});
