import { noContent, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { markPromptUsed } from "@/lib/services/prompts";

/** POST /api/v1/prompts/{id}/use — record a copy/export (drives "recently" and "most used"). */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  await markPromptUsed(db, user.id, id);
  return noContent();
});
