import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { idParamSchema, suggestionsQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getLatestAnalysis, listSuggestions, serialiseAnalysis } from "@/lib/services/analysis";
import { getPrompt } from "@/lib/services/prompts";

/** GET /api/v1/prompts/{id}/suggestions — latest analysis plus suggestions (filter with ?status=). */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  await getPrompt(db, user.id, id); // ownership (404 when not owned)
  const query = parseQuery(request, suggestionsQuerySchema);
  const latest = await getLatestAnalysis(db, user.id, id);
  const items = await listSuggestions(db, user.id, { promptId: id, status: query.status, page: query.page, pageSize: query.page_size });
  return ok({ latest_analysis: latest ? serialiseAnalysis(latest.analysis) : null, items });
});
