import { AppError, notFound } from "@/lib/api/errors";
import { created, parseJson, withApi } from "@/lib/api/handler";
import { feedbackEventSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { recordFeedbackEvent } from "@/lib/services/feedback-events";
import { getPrompt } from "@/lib/services/prompts";
import { getRun } from "@/lib/services/usage";

/**
 * POST /api/v1/prompt-intelligence/feedback — explicit feedback that is not
 * tied to a stored suggestion: helpful/unhelpful ratings of a revision, and
 * dismissing or deferring suggestions of an unsaved analysis. Categories only.
 */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, feedbackEventSchema);
  if (body.run_id && !(await getRun(db, user.id, body.run_id))) throw notFound("Revision");
  if (body.prompt_id) await getPrompt(db, user.id, body.prompt_id);
  if ((body.event_type === "suggestion_dismissed" || body.event_type === "suggestion_deferred") && !body.suggestion_category) {
    throw new AppError("VALIDATION_ERROR", "suggestion_category is required for suggestion feedback.");
  }
  await recordFeedbackEvent(db, {
    userId: user.id,
    eventType: body.event_type,
    runId: body.run_id ?? null,
    promptId: body.prompt_id ?? null,
    suggestionCategory: body.suggestion_category ?? null,
    taskCategory: body.task_category ?? null,
  });
  return created({ recorded: true });
});
