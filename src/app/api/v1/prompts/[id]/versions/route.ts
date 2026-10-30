import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { createVersionSchema, idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { saveLibraryVersion } from "@/lib/services/library";
import { getPrompt, serialiseVersion } from "@/lib/services/prompts";

/** GET /api/v1/prompts/{id}/versions — immutable version history, oldest first. */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const prompt = await getPrompt(db, user.id, id);
  return ok({ items: prompt.versions.map(serialiseVersion), current_version_id: prompt.currentVersionId });
});

/**
 * POST /api/v1/prompts/{id}/versions — save a new immutable version (FR-018).
 * With `optimisation_id` the version is linked to the library optimisation that
 * produced it; `suggestion_ids` are marked applied. Nothing is ever overwritten.
 */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, createVersionSchema);
  const version = await saveLibraryVersion(db, user, id, {
    promptText: body.prompt_text,
    provenance: body.provenance,
    parentVersionId: body.parent_version_id,
    changeSummary: body.change_summary,
    optimisationId: body.optimisation_id,
    suggestionIds: body.suggestion_ids,
  });
  return created(serialiseVersion(version));
});
