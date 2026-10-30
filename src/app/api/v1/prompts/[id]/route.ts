import { noContent, ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, updatePromptSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { deletePrompt, getPrompt, serialisePrompt, serialiseVersion, updatePrompt } from "@/lib/services/prompts";

/** GET /api/v1/prompts/{id} — metadata and all versions (owner only). */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const prompt = await getPrompt(db, user.id, id);
  return ok({ ...serialisePrompt(prompt), versions: prompt.versions.map(serialiseVersion) });
});

/** PATCH /api/v1/prompts/{id} — title, tags, category, archive state. */
export const PATCH = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, updatePromptSchema);
  const prompt = await updatePrompt(db, user.id, id, body);
  return ok(serialisePrompt(prompt));
});

/** DELETE /api/v1/prompts/{id} — delete the prompt and its versions. */
export const DELETE = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  await deletePrompt(db, user.id, id);
  return noContent();
});
