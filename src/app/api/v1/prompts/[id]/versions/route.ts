import { created, parseJson, withApi } from "@/lib/api/handler";
import { createVersionSchema, idParamSchema } from "@/lib/api/validation";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { addVersion, serialiseVersion } from "@/lib/services/prompts";

/** POST /api/v1/prompts/{id}/versions — append an immutable version (FR-018). */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, createVersionSchema);
  const version = await addVersion(db, user.id, planFor(user.planCode), id, {
    promptText: body.prompt_text,
    provenance: body.provenance,
    changeSummary: body.change_summary,
    parentVersionId: body.parent_version_id,
  });
  return created(serialiseVersion(version));
});
