import { created, parseJson, withApi } from "@/lib/api/handler";
import { intelligenceReviseSchema } from "@/lib/api/validation";
import { reviseForUser } from "@/lib/services/intelligence";

import { intelligenceContext, sourceOf } from "../_context";

/**
 * POST /api/v1/prompt-intelligence/generate — build a revised prompt (default mode: detailed) from the structured intent and category template.
 * Returns a proposal only: nothing is saved until the user saves it as a version.
 */
export const POST = withApi({ auth: "required", rateLimit: "revisePerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, intelligenceReviseSchema);
  const mode = body.mode ?? "detailed";
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
  });
  return created(result);
});
