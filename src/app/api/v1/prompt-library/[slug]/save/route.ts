import { created, parseJson, withApi } from "@/lib/api/handler";
import { librarySlugParamSchema, saveLibraryPromptSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { saveTemplateToMyPrompts } from "@/lib/services/prompt-library";

/** POST /api/v1/prompt-library/{slug}/save — copy a library prompt (with filled blanks) into My prompts. */
export const POST = withApi<"required", { slug: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { slug } = librarySlugParamSchema.parse(params);
  const body = await parseJson(request, saveLibraryPromptSchema);
  return created(await saveTemplateToMyPrompts(db, user, slug, body.values ?? {}));
});
