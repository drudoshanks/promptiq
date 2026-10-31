import { AppError } from "@/lib/api/errors";
import { ok, parseJson, withApi } from "@/lib/api/handler";
import { promptPreferencesSchema } from "@/lib/api/validation";
import { isSupportedModel } from "@/lib/config/models";
import { db } from "@/lib/db/client";
import { getFeedbackHistory, getPromptPreferences, serialisePromptPreferences, updatePromptPreferences } from "@/lib/services/prompt-preferences";

/** GET /api/v1/preferences/prompts — prompt preferences plus learned suggestion feedback. */
export const GET = withApi({ auth: "required" }, async ({ user }) => {
  const [prefs, feedback] = await Promise.all([getPromptPreferences(db, user.id), getFeedbackHistory(db, user.id)]);
  return ok({ ...serialisePromptPreferences(prefs), auto_save_enabled: user.historyEnabled, feedback_history: feedback });
});

/** PATCH /api/v1/preferences/prompts — update prompt preferences (auto-save is in /me/preferences-settings). */
export const PATCH = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, promptPreferencesSchema);
  if (body.preferred_model && !isSupportedModel(body.preferred_model)) {
    throw new AppError("UNSUPPORTED_MODEL", `"${body.preferred_model}" is not a supported model.`);
  }
  const prefs = await updatePromptPreferences(db, user.id, {
    preferredModel: body.preferred_model,
    preferredStyle: body.preferred_style,
    preferredResponseLength: body.preferred_response_length,
    tokenEfficiencyPriority: body.token_efficiency_priority,
    defaultOptimisationMode: body.default_optimisation_mode,
    domains: body.domains,
    learnFromFeedback: body.learn_from_feedback,
    backgroundAnalysis: body.background_analysis,
    promptStyle: body.prompt_style,
    taskCategories: body.task_categories,
    helpfulSuggestionCategories: body.helpful_suggestion_categories,
  });
  return ok({ ...serialisePromptPreferences(prefs), auto_save_enabled: user.historyEnabled });
});
