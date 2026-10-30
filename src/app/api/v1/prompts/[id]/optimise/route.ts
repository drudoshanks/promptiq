import { ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, libraryOptimiseSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { getOptimiserProvider } from "@/lib/providers";
import { optimiseLibraryPrompt } from "@/lib/services/library";

/**
 * POST /api/v1/prompts/{id}/optimise — optimise a saved prompt with a mode
 * (balanced | token_saver | quality_first | custom) and selected suggestions.
 * Returns a proposal with the token comparison; no version is created until the
 * user saves it via POST /prompts/{id}/versions with `optimisation_id`.
 */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "optimisePerMinute" }, async (ctx) => {
  const { id } = idParamSchema.parse(ctx.params);
  const body = await parseJson(ctx.request, libraryOptimiseSchema);
  const result = await optimiseLibraryPrompt(
    {
      db,
      user: ctx.user,
      provider: getOptimiserProvider(),
      requestId: ctx.requestId,
      idempotencyKey: ctx.idempotencyKey,
      log: ctx.log,
      globalDailySpendCapUsd: env.GLOBAL_DAILY_SPEND_CAP_USD,
      maxOutputTokensCeiling: env.OPTIMISER_MAX_OUTPUT_TOKENS,
    },
    {
      promptId: id,
      versionId: body.version_id,
      text: body.text,
      mode: body.mode,
      customObjective: body.custom_objective,
      suggestionIds: body.suggestion_ids,
      targetModel: body.target_model,
      expectedOutput: body.expected_output,
    },
  );
  return ok(result);
});
