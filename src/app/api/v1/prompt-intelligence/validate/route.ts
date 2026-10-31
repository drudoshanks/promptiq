import { ok, parseJson, withApi } from "@/lib/api/handler";
import { intelligenceValidateSchema } from "@/lib/api/validation";
import { validateForUser } from "@/lib/services/intelligence";

import { intelligenceContext } from "../_context";

/**
 * POST /api/v1/prompt-intelligence/validate — check that a (possibly
 * hand-edited) revision still contains the original's requirements, and
 * compare token counts and cost. Deterministic unless `semantic` is true.
 */
export const POST = withApi({ auth: "required", rateLimit: "validatePerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, intelligenceValidateSchema);
  return ok(await validateForUser(intelligenceContext(user, requestId, log), { original: body.original, revised: body.revised, targetModel: body.target_model ?? null, semantic: body.semantic }));
});
