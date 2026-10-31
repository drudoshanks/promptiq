import { created, ok, parseJson, parseQuery, withApi } from "@/lib/api/handler";
import { createPromptSchema, listPromptsQuerySchema } from "@/lib/api/validation";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { createPrompt, listPrompts, serialisePrompt, serialiseVersion } from "@/lib/services/prompts";

/** GET /api/v1/prompts — list saved prompts with pagination and search. */
export const GET = withApi({ auth: "required" }, async ({ request, user }) => {
  const query = parseQuery(request, listPromptsQuerySchema);
  const result = await listPrompts(db, user.id, {
    search: query.search,
    category: query.category,
    tag: query.tag,
    targetModel: query.target_model,
    favourite: query.favourite,
    optimisation: query.optimisation,
    priority: query.priority,
    sort: query.sort,
    includeArchived: query.include_archived || query.archived === "include",
    archivedOnly: query.archived === "only",
    page: query.page,
    pageSize: query.page_size,
  });
  return ok({
    items: result.items.map((p) => ({
      ...serialisePrompt(p),
      version_count: p.versionCount,
      preview: p.latestVersion ? p.latestVersion.promptText.replace(/\s+/g, " ").slice(0, 160) : null,
      latest_version: p.latestVersion ? serialiseVersion(p.latestVersion) : null,
    })),
    page: result.page,
    page_size: result.pageSize,
    total: result.total,
  });
});

/** POST /api/v1/prompts — create a saved prompt with its first version(s). */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, createPromptSchema);
  const prompt = await createPrompt(db, user.id, planFor(user.planCode), {
    title: body.title,
    description: body.description,
    targetModel: body.target_model,
    category: body.category,
    tags: body.tags,
    versions: body.versions.map((v) => ({
      promptText: v.prompt_text,
      provenance: v.provenance,
      changeSummary: v.change_summary,
      parentVersionId: v.parent_version_id,
    })),
  });
  return created({ ...serialisePrompt(prompt), versions: prompt.versions.map(serialiseVersion) });
});
