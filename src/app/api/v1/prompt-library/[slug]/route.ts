import { ok, withApi } from "@/lib/api/handler";
import { librarySlugParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getTemplate, relatedTemplates, serialiseTemplate } from "@/lib/services/prompt-library";

/** GET /api/v1/prompt-library/{slug} — one library prompt, with related prompts. */
export const GET = withApi<"required", { slug: string }>({ auth: "required" }, async ({ params }) => {
  const { slug } = librarySlugParamSchema.parse(params);
  const template = await getTemplate(db, slug);
  return ok({ ...serialiseTemplate(template), related: await relatedTemplates(db, template) });
});
