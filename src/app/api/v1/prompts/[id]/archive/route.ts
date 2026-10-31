import { ok, parseJson, withApi } from "@/lib/api/handler";
import { archiveSchema, idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { serialisePrompt, updatePrompt } from "@/lib/services/prompts";

/** PATCH /api/v1/prompts/{id}/archive — `{ "archived": true | false }`. */
export const PATCH = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, archiveSchema);
  return ok(serialisePrompt(await updatePrompt(db, user.id, id, { archived: body.archived })));
});
