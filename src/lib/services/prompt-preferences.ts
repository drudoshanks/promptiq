import { and, eq, inArray, sql } from "drizzle-orm";

import { promptSuggestions, userPromptPreferences, type UserPromptPreferences } from "@/lib/db/schema";
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
} as const;

export async function getPromptPreferences(db: DbOrTx, userId: string): Promise<UserPromptPreferences> {
  const row = await db.query.userPromptPreferences.findFirst({ where: eq(userPromptPreferences.userId, userId) });
  return (
    row ?? {
      userId,
      ...DEFAULT_PROMPT_PREFERENCES,
      domains: [],
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
  const values = { ...update, ...(update.domains ? { domains: cleanDomains(update.domains) } : {}), updatedAt: new Date() };
  const [row] = await db
    .insert(userPromptPreferences)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userPromptPreferences.userId, set: values })
    .returning();
  if (!row) throw new Error("Failed to save prompt preferences");
  return row;
}

/** Per-category counts of the user's suggestion decisions (accepted includes applied). */
export async function getFeedbackHistory(db: DbOrTx, userId: string): Promise<Record<string, { accepted: number; dismissed: number }>> {
  const rows = await db
    .select({
      category: promptSuggestions.category,
      accepted: sql<number>`count(*) filter (where ${promptSuggestions.status} in ('accepted','applied'))`,
      dismissed: sql<number>`count(*) filter (where ${promptSuggestions.status} = 'dismissed')`,
    })
    .from(promptSuggestions)
    .where(and(eq(promptSuggestions.userId, userId), inArray(promptSuggestions.status, ["accepted", "applied", "dismissed"])))
    .groupBy(promptSuggestions.category);
  return Object.fromEntries(rows.map((r) => [r.category, { accepted: Number(r.accepted), dismissed: Number(r.dismissed) }]));
}

/** Forget learned feedback without deleting suggestions: resets decisions to "deferred" history only. */
export async function resetFeedbackHistory(db: DbOrTx, userId: string): Promise<number> {
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
    updated_at: p.updatedAt.getTime() === 0 ? null : p.updatedAt.toISOString(),
  };
}
