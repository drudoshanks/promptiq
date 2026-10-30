import { ok, parseJson, withApi } from "@/lib/api/handler";
import { optimisationRequestSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { optimisePromptForUser } from "@/lib/optimiser/service";
import { getOptimiserProvider } from "@/lib/providers";

/**
 * POST /api/v1/optimisations — generate an optimised prompt (§10.2).
 * Server-side validation, quota, preference injection, provider call,
 * schema validation and idempotency all live in optimisePromptForUser.
 */
export const POST = withApi({ auth: "required", rateLimit: "optimisePerMinute" }, async (ctx) => {
  const body = await parseJson(ctx.request, optimisationRequestSchema);
  const data = await optimisePromptForUser(
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
      prompt: body.prompt,
      taskCategory: body.task_category,
      preferences: body.preferences,
      options: body.options
        ? {
            saveToHistory: body.options.save_to_history,
            outputStyle: body.options.output_style,
            maxOutputTokens: body.options.max_output_tokens,
            title: body.options.title,
            targetModel: body.options.target_model,
            expectedOutput: body.options.expected_output,
          }
        : undefined,
    },
  );
  return ok(data);
});
