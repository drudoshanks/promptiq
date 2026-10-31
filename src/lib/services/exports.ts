import { asc, eq } from "drizzle-orm";

import { feedback, promptAnalyses, promptFeedbackEvents, prompts, promptSuggestions, promptVersions, userPreferences, type AppUser } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

import { serialiseAnalysis, serialiseSuggestion } from "./analysis";
import { serialiseFeedback } from "./feedback";
import { getPromptPreferences, serialisePromptPreferences } from "./prompt-preferences";
import { serialisePreference } from "./preferences";
import { serialisePrompt, serialiseVersion } from "./prompts";

export const ACCOUNT_EXPORT_FORMAT = "promptiq.account";
export const ACCOUNT_EXPORT_VERSION = 1;

/**
 * FR-016 data export in a documented JSON format (docs/data-export-format.md).
 * Includes everything the user owns: profile settings, preferences, prompts
 * with every version, and feedback. Usage metadata is summarised, not itemised.
 */
export async function buildAccountExport(db: DbOrTx, user: AppUser) {
  const [preferenceRows, promptRows, feedbackRows] = await Promise.all([
    db.query.userPreferences.findMany({
      where: eq(userPreferences.userId, user.id),
      orderBy: [asc(userPreferences.category), asc(userPreferences.preferenceKey)],
    }),
    db.query.prompts.findMany({
      where: eq(prompts.userId, user.id),
      orderBy: [asc(prompts.createdAt)],
      with: { versions: { orderBy: [asc(promptVersions.versionNumber)] } },
    }),
    db.query.feedback.findMany({ where: eq(feedback.userId, user.id), orderBy: [asc(feedback.createdAt)] }),
  ]);
  const [analysisRows, suggestionRows, promptPrefs] = await Promise.all([
    db.query.promptAnalyses.findMany({ where: eq(promptAnalyses.userId, user.id), orderBy: [asc(promptAnalyses.createdAt)] }),
    db.query.promptSuggestions.findMany({ where: eq(promptSuggestions.userId, user.id), orderBy: [asc(promptSuggestions.createdAt), asc(promptSuggestions.position)] }),
    getPromptPreferences(db, user.id),
  ]);

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    format_version: ACCOUNT_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    account: {
      email: user.email,
      display_name: user.displayName,
      plan_code: user.planCode,
      history_enabled: user.historyEnabled,
      personalisation_enabled: user.personalisationEnabled,
      created_at: user.createdAt.toISOString(),
    },
    preferences: preferenceRows.map(serialisePreference),
    prompts: promptRows.map((p) => ({
      ...serialisePrompt(p),
      versions: p.versions.map(serialiseVersion),
    })),
    feedback: feedbackRows.map(serialiseFeedback),
    prompt_preferences: serialisePromptPreferences(promptPrefs),
    analyses: analysisRows.map((a) => serialiseAnalysis(a)),
    suggestions: suggestionRows.map(serialiseSuggestion),
    feedback_events: (await db.query.promptFeedbackEvents.findMany({ where: eq(promptFeedbackEvents.userId, user.id), orderBy: [asc(promptFeedbackEvents.createdAt)] })).map((e) => ({
      event_type: e.eventType,
      suggestion_category: e.suggestionCategory,
      task_category: e.taskCategory,
      optimisation_mode: e.optimisationMode,
      prompt_id: e.promptId,
      created_at: e.createdAt.toISOString(),
    })),
  };
}

export type AccountExport = Awaited<ReturnType<typeof buildAccountExport>>;
