import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { analyseRequestSchema, idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { getOptimiserProvider } from "@/lib/providers";
import { analysePrompt, serialiseAnalysis, serialiseSuggestion } from "@/lib/services/analysis";
import { getPrompt } from "@/lib/services/prompts";

/**
 * POST /api/v1/prompts/{id}/analyse — AI review of one version (default: the
 * current one). Only that version's text is sent to the provider. An unchanged
 * version that was already analysed returns the stored result (200) unless
 * `force` is true; a new analysis returns 201 and consumes analysis quota.
 */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "analysePerMinute" }, async ({ request, user, params, requestId, log }) => {
  const { id } = idParamSchema.parse(params);
  const body = request.headers.get("content-length") === "0" ? {} : await parseJson(request, analyseRequestSchema);
  const result = await analysePrompt(
    { db, user, provider: getOptimiserProvider(), requestId, log, globalDailySpendCapUsd: env.GLOBAL_DAILY_SPEND_CAP_USD },
    { promptId: id, versionId: body.version_id, force: body.force, category: body.category ?? null },
  );
  const prompt = await getPrompt(db, user.id, id);
  const versionText = prompt.versions.find((v) => v.id === result.analysis.promptVersionId)?.promptText;
  const payload = { ...serialiseAnalysis(result.analysis, { versionText, currentVersionId: prompt.currentVersionId }), reused: result.reused, suggestions: result.suggestions.map(serialiseSuggestion) };
  return result.reused ? ok(payload) : created(payload);
});
