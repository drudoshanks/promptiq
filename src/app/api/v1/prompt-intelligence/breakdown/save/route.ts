import { created, parseJson, withApi } from "@/lib/api/handler";
import { breakdownSaveSchema } from "@/lib/api/validation";
import { saveBreakdownSteps } from "@/lib/services/breakdown";

import { intelligenceContext } from "../../_context";

/**
 * POST /api/v1/prompt-intelligence/breakdown/save — save each step as its own
 * prompt in My prompts, tagged together. All steps or none.
 */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, requestId, log }) => {
  const body = await parseJson(request, breakdownSaveSchema);
  const result = await saveBreakdownSteps(intelligenceContext(user, requestId, log), {
    title: body.title,
    category: body.category,
    targetModel: body.target_model ?? null,
    breakdownId: body.breakdown_id ?? null,
    steps: body.steps,
  });
  return created(result);
});
