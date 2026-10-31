import { and, eq, inArray, sql } from "drizzle-orm";

import { promptFeedbackEvents, promptSuggestions, userPromptPreferences, type UserPromptPreferences } from "@/lib/db/schema";
import { INTENT_CATEGORIES, SUGGESTION_KINDS } from "@/lib/intelligence/categories";
import type { RankingContext } from "@/lib/intelligence/ranking";
import type { DbOrTx } from "@/lib/db/types";

/**
 * Prompt preferences (Prompt Library §8). Only what the user sets here plus
 * their own accept/dismiss decisions are used to personalise suggestions;
 * nothing is inferred from prompt content.
 */
export const DEFAULT_PROMPT_PREFERENCES = {
  preferredModel: null,
  preferredStyle: null,
  preferredResponseLength: null,
  tokenEfficiencyPriority: "balanced",
  defaultOptimisationMode: "balanced",
  domains: [] as string[],
  learnFromFeedback: true,
  backgroundAnalysis: false,
  promptStyle: null,
} as const;

export async function getPromptPreferences(db: DbOrTx, userId: string): Promise<UserPromptPreferences> {
  const row = await db.query.userPromptPreferences.findFirst({ where: eq(userPromptPreferences.userId, userId) });
  return (
    row ?? {
      userId,
      ...DEFAULT_PROMPT_PREFERENCES,
      domains: [],
      taskCategories: [],
      helpfulSuggestionCategories: [],
      preferencesJson: {},
      updatedAt: new Date(0),
    }
  );
}

export type PromptPreferencesUpdate = Partial<{
  preferredModel: string | null;
  preferredStyle: UserPromptPreferences["preferredStyle"];
  preferredResponseLength: UserPromptPreferences["preferredResponseLength"];
  tokenEfficiencyPriority: UserPromptPreferences["tokenEfficiencyPriority"];
  defaultOptimisationMode: UserPromptPreferences["defaultOptimisationMode"];
  domains: string[];
  learnFromFeedback: boolean;
  backgroundAnalysis: boolean;
  promptStyle: UserPromptPreferences["promptStyle"];
  taskCategories: string[];
  helpfulSuggestionCategories: string[];
}>;

export function cleanDomains(domains: string[]): string[] {
  const out = new Set<string>();
  for (const d of domains) {
    const v = d.trim().replace(/\s+/g, " ").slice(0, 40);
    if (v) out.add(v);
    if (out.size >= 10) break;
  }
  return [...out];
}

export async function updatePromptPreferences(db: DbOrTx, userId: string, update: PromptPreferencesUpdate): Promise<UserPromptPreferences> {
  const values = {
    ...update,
    ...(update.domains ? { domains: cleanDomains(update.domains) } : {}),
    ...(update.taskCategories ? { taskCategories: update.taskCategories.filter((c) => (INTENT_CATEGORIES as readonly string[]).includes(c)).slice(0, 11) } : {}),
    ...(update.helpfulSuggestionCategories ? { helpfulSuggestionCategories: update.helpfulSuggestionCategories.filter((c) => (SUGGESTION_KINDS as readonly string[]).includes(c)).slice(0, 10) } : {}),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(userPromptPreferences)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userPromptPreferences.userId, set: values })
    .returning();
  if (!row) throw new Error("Failed to save prompt preferences");
  return row;
}

type Counts = Record<string, { accepted: number; dismissed: number }>;

/**
 * Per-category counts of the user's explicit suggestion decisions, from the
 * feedback event log. With `taskCategory`, also returns counts within that task.
 */
export async function getFeedbackHistory(db: DbOrTx, userId: string): Promise<Counts> {
  return (await getFeedbackCounts(db, userId)).byKind;
}

export async function getFeedbackCounts(db: DbOrTx, userId: string, taskCategory?: string | null): Promise<{ byKind: Counts; byKindForTask: Counts }> {
  const rows = await db
    .select({
      category: promptFeedbackEvents.suggestionCategory,
      task: promptFeedbackEvents.taskCategory,
      accepted: sql<number>`count(*) filter (where ${promptFeedbackEvents.eventType} = 'suggestion_accepted')`,
      dismissed: sql<number>`count(*) filter (where ${promptFeedbackEvents.eventType} = 'suggestion_dismissed')`,
    })
    .from(promptFeedbackEvents)
    .where(and(eq(promptFeedbackEvents.userId, userId), inArray(promptFeedbackEvents.eventType, ["suggestion_accepted", "suggestion_dismissed"])))
    .groupBy(promptFeedbackEvents.suggestionCategory, promptFeedbackEvents.taskCategory);
  const byKind: Counts = {};
  const byKindForTask: Counts = {};
  for (const r of rows) {
    if (!r.category) continue;
    const add = (target: Counts) => {
      const c = (target[r.category!] ??= { accepted: 0, dismissed: 0 });
      c.accepted += Number(r.accepted);
      c.dismissed += Number(r.dismissed);
    };
    add(byKind);
    if (taskCategory && r.task === taskCategory) add(byKindForTask);
  }
  return { byKind, byKindForTask };
}

/** Everything the ranking model needs for one user and task. */
export async function getRankingContext(db: DbOrTx, userId: string, taskCategory?: string | null): Promise<RankingContext> {
  const prefs = await getPromptPreferences(db, userId);
  const counts = prefs.learnFromFeedback ? await getFeedbackCounts(db, userId, taskCategory) : { byKind: {}, byKindForTask: {} };
  return {
    byKind: counts.byKind,
    byKindForTask: counts.byKindForTask,
    learnFromFeedback: prefs.learnFromFeedback,
    preferences: {
      tokenEfficiencyPriority: prefs.tokenEfficiencyPriority,
      helpfulCategories: prefs.helpfulSuggestionCategories,
      preferredOutputFormat: prefs.preferredStyle,
      promptStyle: prefs.promptStyle,
    },
  };
}

/** Preference fields the user approved for sending to the model (§11). */
export function preferencesForModel(p: UserPromptPreferences): Record<string, unknown> {
  return {
    prompt_style: p.promptStyle,
    preferred_output_format: p.preferredStyle,
    preferred_response_length: p.preferredResponseLength,
    token_efficiency_priority: p.tokenEfficiencyPriority,
    domains: p.domains,
  };
}

/** Forget learned feedback: clears the suggestion decision log and un-dismisses suggestions. */
export async function resetFeedbackHistory(db: DbOrTx, userId: string): Promise<number> {
  await db
    .delete(promptFeedbackEvents)
    .where(and(eq(promptFeedbackEvents.userId, userId), inArray(promptFeedbackEvents.eventType, ["suggestion_accepted", "suggestion_dismissed", "suggestion_deferred"])));
  const rows = await db
    .update(promptSuggestions)
    .set({ status: "deferred", feedbackAt: new Date() })
    .where(and(eq(promptSuggestions.userId, userId), eq(promptSuggestions.status, "dismissed")))
    .returning({ id: promptSuggestions.id });
  return rows.length;
}

export function serialisePromptPreferences(p: UserPromptPreferences) {
  return {
    preferred_model: p.preferredModel,
    preferred_style: p.preferredStyle,
    preferred_response_length: p.preferredResponseLength,
    token_efficiency_priority: p.tokenEfficiencyPriority,
    default_optimisation_mode: p.defaultOptimisationMode,
    domains: p.domains,
    learn_from_feedback: p.learnFromFeedback,
    background_analysis: p.backgroundAnalysis,
    prompt_style: p.promptStyle,
    task_categories: p.taskCategories,
    helpful_suggestion_categories: p.helpfulSuggestionCategories,
    updated_at: p.updatedAt.getTime() === 0 ? null : p.updatedAt.toISOString(),
  };
}
