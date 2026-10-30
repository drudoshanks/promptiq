import { notFound } from "@/lib/api/errors";
import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getFeedbackForRun, serialiseFeedback } from "@/lib/services/feedback";
import { getPrompt, serialiseVersion } from "@/lib/services/prompts";
import { getRun, serialiseRun } from "@/lib/services/usage";

/**
 * GET /api/v1/optimisations/{id} — run metadata, plus the saved result when the
 * optimisation was stored in history. Runs never contain prompt text themselves.
 */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const run = await getRun(db, user.id, id);
  if (!run) throw notFound("Optimisation");

  let result: { original: ReturnType<typeof serialiseVersion> | null; optimised: ReturnType<typeof serialiseVersion> | null } | null = null;
  if (run.promptId) {
    try {
      const prompt = await getPrompt(db, user.id, run.promptId);
      const original = prompt.versions.find((v) => v.id === run.sourceVersionId);
      const optimised = prompt.versions.find((v) => v.id === run.resultVersionId);
      result = {
        original: original ? serialiseVersion(original) : null,
        optimised: optimised ? serialiseVersion(optimised) : null,
      };
    } catch {
      result = null; // prompt deleted since the run
    }
  }

  const fb = await getFeedbackForRun(db, user.id, id);
  return ok({ ...serialiseRun(run), result, feedback: fb ? serialiseFeedback(fb) : null });
});
