import { created, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { duplicatePrompt, serialisePrompt, serialiseVersion } from "@/lib/services/prompts";

/** POST /api/v1/prompts/{id}/duplicate — new prompt from the current version. */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const copy = await duplicatePrompt(db, user.id, planFor(user.planCode), id);
  return created({ ...serialisePrompt(copy), versions: copy.versions.map(serialiseVersion) });
});
