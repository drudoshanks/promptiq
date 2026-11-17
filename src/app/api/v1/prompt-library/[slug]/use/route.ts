import { noContent, withApi } from "@/lib/api/handler";
import { librarySlugParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getTemplate, recordTemplateUse } from "@/lib/services/prompt-library";

/** POST /api/v1/prompt-library/{slug}/use — count a copy or an "Open in Studio". */
export const POST = withApi<"required", { slug: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ params }) => {
  const { slug } = librarySlugParamSchema.parse(params);
  await getTemplate(db, slug);
  await recordTemplateUse(db, slug);
  return noContent();
});
