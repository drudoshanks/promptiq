import { ok, parseJson, withApi } from "@/lib/api/handler";
import { intelligenceBreakdownSchema } from "@/lib/api/validation";
import { breakdownForUser } from "@/lib/services/breakdown";

import { intelligenceContext, sourceOf } from "../_context";

/**
 * POST /api/v1/prompt-intelligence/breakdown — split one prompt into a short
 * sequence of smaller, self-contained prompts, with advice on running them
 * and a check that every requirement is carried by a step. Nothing is stored.
 */
export const POST = withApi({ auth: "required", rateLimit: "intelligenceBreakdownPerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, intelligenceBreakdownSchema);
  const result = await breakdownForUser(intelligenceContext(user, requestId, log), {
    source: sourceOf(body),
    category: body.category ?? null,
    targetModel: body.target_model ?? null,
  });
  return ok(result);
});
