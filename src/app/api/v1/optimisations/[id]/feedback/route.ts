import { created, noContent, ok, parseJson, withApi } from "@/lib/api/handler";
import { feedbackRequestSchema, idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { deleteFeedback, serialiseFeedback, submitFeedback } from "@/lib/services/feedback";
import { recordFeedbackEvent } from "@/lib/services/feedback-events";
import { serialisePreference, upsertPreference } from "@/lib/services/preferences";

/**
 * POST /api/v1/optimisations/{id}/feedback (§10.3). Feedback never becomes a
 * preference on its own (FR-012); only an explicit `save_preference` does, and
 * the server assigns source=user_confirmed.
 */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, feedbackRequestSchema);

  const { feedback, created: isNew } = await submitFeedback(db, user.id, id, {
    rating: body.rating,
    reasonCode: body.reason_code ?? null,
    comment: body.comment ?? null,
    preferenceSuggestion: body.save_preference ?? null,
    replace: body.replace,
  });

  let savedPreference = null;
  if (body.save_preference) {
    const { preference } = await upsertPreference(db, user.id, {
      category: body.save_preference.category,
      preferenceKey: body.save_preference.preference_key,
      preferenceValue: { value: body.save_preference.value },
      source: "user_confirmed",
    });
    savedPreference = serialisePreference(preference);
  }

  const payload = { ...serialiseFeedback(feedback), saved_preference: savedPreference };
  await recordFeedbackEvent(db, { userId: user.id, eventType: body.rating > 0 ? "rated_helpful" : "rated_unhelpful", runId: id });
  return isNew ? created(payload) : ok(payload);
});

/** DELETE /api/v1/optimisations/{id}/feedback — withdraw feedback (FR-021). */
export const DELETE = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  await deleteFeedback(db, user.id, id);
  return noContent();
});
