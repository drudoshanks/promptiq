import { and, eq, inArray } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import { isTaskCategory } from "@/lib/categories";
import type { OutputLengthPreset } from "@/lib/config/estimates";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { optimisationRuns, promptSuggestions, type AppUser, type PromptVersion, type Provenance } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { OptimiserMode } from "@/lib/optimiser/instructions";
import { optimisePromptForUser, type OptimisationResponse, type OptimiseServiceContext } from "@/lib/optimiser/service";

import { getOwnedSuggestions, markSuggestionsApplied } from "./analysis";
import { getPromptPreferences } from "./prompt-preferences";
import { addVersion, getPrompt, refreshPromptStats } from "./prompts";

export interface OptimiseLibraryInput {
  promptId: string;
  /** Version to start from; defaults to the current version. */
  versionId?: string | null;
  /** The user's edited revision to optimise instead of the stored text. */
  text?: string | null;
  mode?: OptimiserMode;
  customObjective?: string | null;
  /** Suggestions to apply; they are marked accepted. */
  suggestionIds?: string[];
  targetModel?: string | null;
  expectedOutput?: OutputLengthPreset | number;
}

export interface LibraryOptimisation extends OptimisationResponse {
  source_version_id: string;
  suggestion_ids: string[];
}

/**
 * Optimise a saved prompt (Prompt Library §6–7). Returns a proposal only: no
 * version is written until the user saves it with saveLibraryVersion().
 */
export async function optimiseLibraryPrompt(ctx: OptimiseServiceContext, input: OptimiseLibraryInput): Promise<LibraryOptimisation> {
  const { db, user } = ctx;
  const prompt = await getPrompt(db, user.id, input.promptId);
  const version = input.versionId ? prompt.versions.find((v) => v.id === input.versionId) : prompt.versions[prompt.versions.length - 1];
  if (!version) throw notFound("Version");

  const suggestionIds = [...new Set(input.suggestionIds ?? [])];
  const suggestions = await getOwnedSuggestions(db, user.id, prompt.id, suggestionIds);
  if (suggestions.some((s) => s.status === "applied" || s.status === "dismissed")) {
    throw new AppError("CONFLICT", "Only pending, deferred or accepted suggestions can be applied.");
  }
  if (suggestions.length) {
    await db
      .update(promptSuggestions)
      .set({ status: "accepted", feedbackAt: new Date() })
      .where(and(eq(promptSuggestions.userId, user.id), inArray(promptSuggestions.id, suggestionIds)));
  }

  const prefs = await getPromptPreferences(db, user.id);
  // The legacy optimiser has no "detailed" mode; quality-first is its closest equivalent.
  const mode: OptimiserMode = input.mode ?? (prefs.defaultOptimisationMode === "detailed" ? "quality_first" : prefs.defaultOptimisationMode);
  if (mode === "custom" && !input.customObjective?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Describe your objective for custom optimisation.");
  }

  const response = await optimisePromptForUser(ctx, {
    prompt: input.text?.trim() ? input.text : version.promptText,
    taskCategory: isTaskCategory(prompt.category) ? prompt.category : "general",
    options: {
      saveToHistory: false,
      targetModel: input.targetModel ?? prompt.targetModel ?? prefs.preferredModel ?? DEFAULT_TARGET_MODEL,
      expectedOutput: input.expectedOutput ?? prefs.preferredResponseLength ?? undefined,
      mode,
      customObjective: input.customObjective ?? null,
      acceptedSuggestions: suggestions.map((s) => s.recommendation),
      library: { promptId: prompt.id, sourceVersionId: version.id },
    },
  });
  return { ...response, source_version_id: version.id, suggestion_ids: suggestionIds };
}

export interface SaveLibraryVersionInput {
  promptText: string;
  provenance?: Provenance;
  parentVersionId?: string | null;
  changeSummary?: string[];
  /** The library optimisation that produced this text. */
  optimisationId?: string | null;
  /** Suggestions incorporated in this text; marked applied. */
  suggestionIds?: string[];
}

/**
 * Save a reviewed revision as a new immutable version, link it to the
 * optimisation run that produced it and mark incorporated suggestions applied.
 * Nothing is written if validation fails, so a failed or foreign run can never
 * produce a half-linked version.
 */
export async function saveLibraryVersion(db: Db, user: AppUser, promptId: string, input: SaveLibraryVersionInput): Promise<PromptVersion> {
  const prompt = await getPrompt(db, user.id, promptId);
  let provenance: Provenance = input.provenance ?? "user_edited";

  if (input.optimisationId) {
    const run = await db.query.optimisationRuns.findFirst({
      where: and(eq(optimisationRuns.id, input.optimisationId), eq(optimisationRuns.userId, user.id)),
    });
    if (!run || run.promptId !== prompt.id) throw notFound("Optimisation");
    if (run.status !== "succeeded") throw new AppError("CONFLICT", "Only a successful optimisation can be saved as a version.");
    if (run.resultVersionId) throw new AppError("CONFLICT", "This optimisation has already been saved as a version.", { details: { version_id: run.resultVersionId } });
    if (!input.provenance) provenance = "ai_optimised";
  }
  const suggestionIds = [...new Set(input.suggestionIds ?? [])];
  const suggestions = await getOwnedSuggestions(db, user.id, prompt.id, suggestionIds);
  if (suggestions.some((s) => s.status === "applied")) throw new AppError("CONFLICT", "A suggestion is already part of a saved version.");
  if (suggestions.length && !input.optimisationId && !input.provenance) provenance = "suggestion_applied";

  const version = await addVersion(db, user.id, planFor(user.planCode), prompt.id, {
    promptText: input.promptText,
    provenance,
    parentVersionId: input.parentVersionId ?? prompt.currentVersionId ?? null,
    changeSummary: input.changeSummary,
    optimisationRunId: input.optimisationId ?? null,
  });
  if (input.optimisationId) {
    await db.update(optimisationRuns).set({ resultVersionId: version.id }).where(eq(optimisationRuns.id, input.optimisationId));
  }
  await markSuggestionsApplied(db, user.id, prompt.id, suggestionIds, version.id);
  await refreshPromptStats(db, prompt.id);
  return version;
}
