import { ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, suggestionStatusSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { serialiseSuggestion, setSuggestionStatus } from "@/lib/services/analysis";

/** PATCH /api/v1/suggestions/{id} — accept, dismiss, defer, or reset to pending. */
export const PATCH = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, suggestionStatusSchema);
  return ok(serialiseSuggestion(await setSuggestionStatus(db, user.id, id, body.status)));
});
