import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { tokenEstimateRequestSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import {
  assertEstimateLinksOwned,
  compareTexts,
  estimateText,
  recordTokenEstimate,
  serialiseTokenEstimate,
} from "@/lib/services/estimates";

/**
 * POST /api/v1/token-estimates — count tokens and estimate cost (no LLM call).
 *
 * `{ model, text }` counts one text; `{ model, original_text, optimised_text }`
 * compares two with the same tokenizer. Counts cover exactly the supplied text:
 * message wrappers, system instructions, history, tools and attachments are not
 * included (`count_type: "text_token_estimate"`). Nothing is stored unless
 * `record` is sent (used once before export, never while typing).
 */
export const POST = withApi({ auth: "required", rateLimit: "estimatePerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, tokenEstimateRequestSchema);

  if (body.text === undefined) {
    const comparison = await compareTexts(db, {
      original: body.original_text as string,
      optimised: body.optimised_text as string,
      modelId: body.model,
      expectedOutput: body.expected_output,
    });
    return ok(comparison);
  }

  const estimate = await estimateText(db, { text: body.text, modelId: body.model, expectedOutput: body.expected_output });
  if (!body.record) return ok(estimate);

  await assertEstimateLinksOwned(db, user.id, { runId: body.record.run_id, promptVersionId: body.record.prompt_version_id });
  const row = await recordTokenEstimate(db, {
    userId: user.id,
    label: body.record.label,
    estimate,
    runId: body.record.run_id ?? null,
    promptVersionId: body.record.prompt_version_id ?? null,
  });
  return created({ ...estimate, recorded: serialiseTokenEstimate(row) });
});
