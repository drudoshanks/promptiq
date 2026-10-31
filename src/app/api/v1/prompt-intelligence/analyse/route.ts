import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { intelligenceAnalyseSchema } from "@/lib/api/validation";
import { analyseForUser } from "@/lib/services/intelligence";

import { intelligenceContext, sourceOf } from "../_context";

/**
 * POST /api/v1/prompt-intelligence/analyse — classify the task, score
 * completeness, extract requirements and rank suggestions for one prompt.
 * A saved version (prompt_id without prompt_text) is stored against that
 * version; unsaved text is analysed without storing it.
 */
export const POST = withApi({ auth: "required", rateLimit: "intelligenceAnalysePerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, intelligenceAnalyseSchema);
  const result = await analyseForUser(intelligenceContext(user, requestId, log), {
    source: sourceOf(body),
    category: body.category ?? null,
    targetModel: body.target_model ?? null,
    force: body.force,
  });
  return result.reused ? ok(result) : created(result);
});
