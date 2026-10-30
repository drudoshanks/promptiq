import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import type { TaskCategory } from "@/lib/categories";
import { DEFAULT_TARGET_MODEL, isSupportedModel } from "@/lib/config/models";
import type { PlanLimits } from "@/lib/config/plans";
import { calculateCost } from "@/lib/cost";
import {
  optimisationRuns,
  promptAnalyses,
  promptSuggestions,
  promptVersions,
  prompts,
  type Prompt,
  type PromptVersion,
  type Provenance,
} from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import { estimateTokens, TOKENIZER_VERSION } from "@/lib/tokens";

import { invalidateDashboard } from "./dashboard-cache";
import { getPricingFor } from "./pricing";

export interface NewVersionInput {
  promptText: string;
  provenance: Provenance;
  changeSummary?: string[];
  parentVersionId?: string | null;
  /** The library optimisation run that produced this text, if any. */
  optimisationRunId?: string | null;
}

export interface CreatePromptInput {
  title?: string;
  description?: string | null;
  category: TaskCategory;
  tags?: string[];
  targetModel?: string | null;
  /** Versions to create in order; the first becomes version 1. */
  versions: NewVersionInput[];
}

export interface PromptWithVersions extends Prompt {
  versions: PromptVersion[];
}

/**
 * Default title from the prompt's first line, cut at a word boundary. A
 * readable fallback, never an AI call: saving must not depend on one (§3).
 */
export function deriveTitle(text: string): string {
  const firstLine = (text.trim().split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  if (!firstLine) return "Untitled prompt";
  if (firstLine.length <= 60) return firstLine;
  const cut = firstLine.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.-]+$/, "")}…`;
}

function cleanTitle(title: string | undefined, fallbackText: string): string {
  const explicit = (title ?? "").trim().replace(/\s+/g, " ");
  return explicit ? explicit.slice(0, 120) : deriveTitle(fallbackText);
}

function cleanDescription(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? v.slice(0, 1000) : null;
}

function checkTargetModel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (!isSupportedModel(model)) throw new AppError("UNSUPPORTED_MODEL", `"${model}" is not a supported target model.`);
  return model;
}

export function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30);
    if (tag && !seen.has(tag)) seen.add(tag);
    if (seen.size >= 10) break;
  }
  return [...seen];
}

function versionValues(promptId: string, userId: string, versionNumber: number, v: NewVersionInput, parentVersionId: string | null) {
  const estimate = estimateTokens(v.promptText);
  return {
    promptId,
    versionNumber,
    parentVersionId,
    provenance: v.provenance,
    promptText: v.promptText,
    changeSummary: v.changeSummary ?? [],
    tokenEstimate: estimate.tokens,
    tokenEstimateMethod: estimate.method,
    tokenizerVersion: estimate.method === "approximate" ? null : TOKENIZER_VERSION,
    createdBy: userId,
    optimisationRunId: v.optimisationRunId ?? null,
  };
}

/**
 * Recompute a prompt's denormalised library columns from the source tables:
 * current version, token counts, optimisation count and status, latest
 * analysis score, pending suggestions and the estimated input cost of the
 * current text. Called after every write that can change them, so the values
 * the dashboard filters and sorts on never drift from the truth.
 */
export async function refreshPromptStats(db: DbOrTx, promptId: string): Promise<void> {
  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, promptId) });
  if (!prompt) return;

  const [first, latest] = await Promise.all([
    db.query.promptVersions.findFirst({ where: eq(promptVersions.promptId, promptId), orderBy: [asc(promptVersions.versionNumber)] }),
    db.query.promptVersions.findFirst({ where: eq(promptVersions.promptId, promptId), orderBy: [desc(promptVersions.versionNumber)] }),
  ]);

  const runRows = await db
    .select({ total: sql<number>`count(*) filter (where ${optimisationRuns.status} = 'succeeded')` })
    .from(optimisationRuns)
    .where(eq(optimisationRuns.promptId, promptId));
  const lastRun = await db.query.optimisationRuns.findFirst({
    where: eq(optimisationRuns.promptId, promptId),
    orderBy: [desc(optimisationRuns.createdAt)],
    columns: { status: true },
  });

  const analysis = await db.query.promptAnalyses.findFirst({
    where: and(eq(promptAnalyses.promptId, promptId), eq(promptAnalyses.status, "completed")),
    orderBy: [desc(promptAnalyses.createdAt)],
    columns: { id: true, qualityScore: true, completedAt: true },
  });
  let pending = 0;
  let pendingPriority = 0;
  if (analysis) {
    const rows = await db
      .select({
        n: count(),
        top: sql<number>`coalesce(max(case ${promptSuggestions.priority} when 'high' then 3 when 'medium' then 2 else 1 end), 0)`,
      })
      .from(promptSuggestions)
      .where(and(eq(promptSuggestions.analysisId, analysis.id), eq(promptSuggestions.status, "pending")));
    pending = Number(rows[0]?.n ?? 0);
    pendingPriority = Number(rows[0]?.top ?? 0);
  }

  const currentTokens = latest?.tokenEstimate ?? null;
  const pricing = currentTokens !== null ? await getPricingFor(db, prompt.targetModel ?? DEFAULT_TARGET_MODEL) : null;
  const cost = currentTokens !== null ? calculateCost(pricing, { inputTokens: currentTokens, outputTokens: 0 }) : null;

  await db
    .update(prompts)
    .set({
      currentVersionId: latest?.id ?? null,
      currentVersionNumber: latest?.versionNumber ?? 1,
      originalTokenCount: first?.tokenEstimate ?? null,
      currentTokenCount: currentTokens,
      optimisationCount: Number(runRows[0]?.total ?? 0),
      latestOptimisationStatus: lastRun?.status ?? null,
      latestQualityScore: analysis?.qualityScore ?? null,
      latestAnalysisAt: analysis?.completedAt ?? null,
      pendingSuggestionCount: pending,
      pendingPriority,
      latestEstimatedCost: cost ? cost.input_cost.toFixed(10) : null,
      latestPricingVersion: cost?.pricing_version ?? null,
    })
    .where(eq(prompts.id, promptId));
  invalidateDashboard(prompt.userId);
}

/**
 * Create a prompt and its first version(s) in one transaction (FR-009, FR-018).
 * Version numbers are assigned inside the transaction so they are gap-free and
 * unique per prompt.
 */
export async function createPrompt(db: Db, userId: string, plan: PlanLimits, input: CreatePromptInput): Promise<PromptWithVersions> {
  if (input.versions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one version is required.");
  }
  const targetModel = checkTargetModel(input.targetModel);
  return db.transaction(async (tx) => {
    const countRows = await tx
      .select({ total: count() })
      .from(prompts)
      .where(and(eq(prompts.userId, userId), isNull(prompts.archivedAt)));
    if (Number(countRows[0]?.total ?? 0) >= plan.maxSavedPrompts) {
      throw new AppError("FORBIDDEN", `Your plan allows ${plan.maxSavedPrompts} saved prompts. Archive or delete a prompt, or upgrade.`, {
        details: { limit: plan.maxSavedPrompts },
      });
    }

    const firstText = input.versions[0]?.promptText ?? "";
    const [prompt] = await tx
      .insert(prompts)
      .values({
        userId,
        title: cleanTitle(input.title, firstText),
        description: cleanDescription(input.description),
        category: input.category,
        tags: cleanTags(input.tags),
        targetModel,
      })
      .returning();
    if (!prompt) throw new Error("Failed to create prompt");

    const versions: PromptVersion[] = [];
    let parentId: string | null = null;
    let versionNumber = 0;
    for (const v of input.versions.slice(0, plan.maxVersionsPerPrompt)) {
      versionNumber += 1;
      const parentForThis: string | null = v.parentVersionId === undefined ? parentId : v.parentVersionId;
      const [version]: PromptVersion[] = await tx.insert(promptVersions).values(versionValues(prompt.id, userId, versionNumber, v, parentForThis)).returning();
      if (!version) throw new Error("Failed to create version");
      versions.push(version);
      parentId = version.id;
    }
    await refreshPromptStats(tx, prompt.id);
    const refreshed = await tx.query.prompts.findFirst({ where: eq(prompts.id, prompt.id) });
    return { ...(refreshed ?? prompt), versions };
  });
}

/** Append an immutable version; numbering is serialised by locking the prompt row. */
export async function addVersion(db: Db, userId: string, plan: PlanLimits, promptId: string, input: NewVersionInput): Promise<PromptVersion> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: prompts.id })
      .from(prompts)
      .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
      .for("update");
    if (!owned) throw notFound("Prompt");

    const stats = await tx
      .select({
        latest: sql<number>`coalesce(max(${promptVersions.versionNumber}), 0)`,
        total: count(),
      })
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptId));
    const latest = Number(stats[0]?.latest ?? 0);
    const total = Number(stats[0]?.total ?? 0);
    if (total >= plan.maxVersionsPerPrompt) {
      throw new AppError("FORBIDDEN", `Your plan keeps up to ${plan.maxVersionsPerPrompt} versions per prompt.`, {
        details: { limit: plan.maxVersionsPerPrompt },
      });
    }

    if (input.parentVersionId) {
      const parent = await tx.query.promptVersions.findFirst({
        where: and(eq(promptVersions.id, input.parentVersionId), eq(promptVersions.promptId, promptId)),
      });
      if (!parent) throw new AppError("CONFLICT", "parent_version_id does not belong to this prompt.");
    }

    const [version] = await tx
      .insert(promptVersions)
      .values(versionValues(promptId, userId, latest + 1, input, input.parentVersionId ?? null))
      .returning();
    if (!version) throw new Error("Failed to create version");

    await tx.update(prompts).set({ updatedAt: new Date() }).where(eq(prompts.id, promptId));
    await refreshPromptStats(tx, promptId);
    return version;
  });
}

/** Create a new version from an earlier one (§2.11). History is never rewritten. */
export async function restoreVersion(db: Db, userId: string, plan: PlanLimits, promptId: string, versionId: string): Promise<PromptVersion> {
  const prompt = await getPrompt(db, userId, promptId);
  const source = prompt.versions.find((v) => v.id === versionId);
  if (!source) throw notFound("Version");
  return addVersion(db, userId, plan, promptId, {
    promptText: source.promptText,
    provenance: "restored",
    parentVersionId: source.id,
    changeSummary: [`Restored from version ${source.versionNumber}.`],
  });
}

/** Copy a prompt's current text into a new prompt (version 1, provenance "duplicated"). */
export async function duplicatePrompt(db: Db, userId: string, plan: PlanLimits, promptId: string): Promise<PromptWithVersions> {
  const source = await getPrompt(db, userId, promptId);
  const current = source.versions[source.versions.length - 1];
  if (!current) throw notFound("Version");
  return createPrompt(db, userId, plan, {
    title: `Copy of ${source.title}`.slice(0, 120),
    description: source.description,
    category: (source.category as TaskCategory) ?? "general",
    tags: source.tags,
    targetModel: source.targetModel,
    versions: [{ promptText: current.promptText, provenance: "duplicated", changeSummary: [`Duplicated from "${source.title}" version ${current.versionNumber}.`] }],
  });
}

/** Record that the user copied or exported the prompt (for "recently used" and "most used"). */
export async function markPromptUsed(db: DbOrTx, userId: string, promptId: string): Promise<void> {
  const updated = await db
    .update(prompts)
    .set({ lastUsedAt: new Date(), useCount: sql`${prompts.useCount} + 1` })
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
    .returning({ id: prompts.id });
  if (updated.length === 0) throw notFound("Prompt");
  invalidateDashboard(userId);
}

export const LIBRARY_SORTS = ["recent", "oldest", "most_used", "largest", "most_saved", "attention"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface ListPromptsOptions {
  search?: string;
  category?: TaskCategory;
  tag?: string;
  targetModel?: string;
  favourite?: boolean;
  /** "optimised": has at least one successful optimisation; "not_optimised": none. */
  optimisation?: "optimised" | "not_optimised";
  /** "attention": pending high/medium suggestions or a low score; or a minimum pending priority. */
  priority?: "attention" | "high" | "medium" | "low";
  includeArchived?: boolean;
  archivedOnly?: boolean;
  sort?: LibrarySort;
  page?: number;
  pageSize?: number;
}

export interface PromptListItem extends Prompt {
  versionCount: number;
  latestVersion: PromptVersion | null;
}

/** Score below which a prompt counts as needing improvement (heuristic, §4). */
export const NEEDS_IMPROVEMENT_SCORE = 60;

/** Tokens saved by the current version against version 1 (per prompt, never per run). */
const tokensSavedExpr = sql<number>`coalesce(${prompts.originalTokenCount} - ${prompts.currentTokenCount}, 0)`;

/**
 * The caller's prompts with server-side search, filters, sort and pagination.
 * Search covers title, tags and version text (PostgreSQL full-text + ILIKE).
 */
export async function listPrompts(db: DbOrTx, userId: string, options: ListPromptsOptions = {}): Promise<{ items: PromptListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20));
  const search = (options.search ?? "").trim().slice(0, 200);

  const conditions: SQL[] = [eq(prompts.userId, userId)];
  if (options.archivedOnly) conditions.push(isNotNull(prompts.archivedAt));
  else if (!options.includeArchived) conditions.push(isNull(prompts.archivedAt));
  if (options.category) conditions.push(eq(prompts.category, options.category));
  if (options.tag) conditions.push(sql`${options.tag} = ANY(${prompts.tags})`);
  if (options.targetModel) conditions.push(eq(prompts.targetModel, options.targetModel));
  if (options.favourite) conditions.push(eq(prompts.isFavourite, true));
  if (options.optimisation === "optimised") conditions.push(sql`${prompts.optimisationCount} > 0`);
  if (options.optimisation === "not_optimised") conditions.push(sql`${prompts.optimisationCount} = 0`);
  if (options.priority === "attention") {
    conditions.push(sql`(${prompts.pendingPriority} >= 2 OR ${prompts.latestQualityScore} < ${NEEDS_IMPROVEMENT_SCORE})`);
  } else if (options.priority) {
    conditions.push(sql`${prompts.pendingPriority} >= ${{ high: 3, medium: 2, low: 1 }[options.priority]}`);
  }
  if (search) {
    const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
    const textMatch = sql`EXISTS (
      SELECT 1 FROM ${promptVersions} v
      WHERE v.prompt_id = ${prompts.id}
        AND (to_tsvector('english', v.prompt_text) @@ plainto_tsquery('english', ${search}) OR v.prompt_text ILIKE ${pattern})
    )`;
    conditions.push(or(ilike(prompts.title, pattern), sql`array_to_string(${prompts.tags}, ' ') ILIKE ${pattern}`, textMatch)!);
  }
  const where = and(...conditions);

  const orderBy: SQL[] = (() => {
    switch (options.sort ?? "recent") {
      case "oldest":
        return [asc(prompts.createdAt)];
      case "most_used":
        return [desc(prompts.useCount), sql`${prompts.lastUsedAt} DESC NULLS LAST`];
      case "largest":
        return [sql`${prompts.currentTokenCount} DESC NULLS LAST`];
      case "most_saved":
        return [desc(tokensSavedExpr)];
      case "attention":
        return [desc(prompts.pendingPriority), sql`${prompts.latestQualityScore} ASC NULLS LAST`];
      default:
        return [desc(prompts.updatedAt)];
    }
  })();

  const countRows = await db.select({ total: count() }).from(prompts).where(where);
  const total = Number(countRows[0]?.total ?? 0);
  const rows = await db.query.prompts.findMany({
    where,
    orderBy: [...orderBy, desc(prompts.id)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // One query for the latest version of the page's prompts, not one per row.
  const latestByPrompt = new Map<string, PromptVersion>();
  const ids = rows.map((r) => r.currentVersionId).filter((id): id is string => Boolean(id));
  if (ids.length) {
    const versions = await db.query.promptVersions.findMany({ where: inArray(promptVersions.id, ids) });
    for (const v of versions) latestByPrompt.set(v.promptId, v);
  }
  const items: PromptListItem[] = rows.map((row) => ({ ...row, versionCount: row.currentVersionNumber, latestVersion: latestByPrompt.get(row.id) ?? null }));
  return { items, total, page, pageSize };
}

export async function getPrompt(db: DbOrTx, userId: string, promptId: string): Promise<PromptWithVersions> {
  const row = await db.query.prompts.findFirst({
    where: and(eq(prompts.id, promptId), eq(prompts.userId, userId)),
    with: { versions: { orderBy: [asc(promptVersions.versionNumber)] } },
  });
  if (!row) throw notFound("Prompt");
  return row;
}

export async function getVersion(db: DbOrTx, userId: string, promptId: string, versionId: string): Promise<PromptVersion> {
  const prompt = await getPrompt(db, userId, promptId);
  const version = prompt.versions.find((v) => v.id === versionId);
  if (!version) throw notFound("Version");
  return version;
}

export interface UpdatePromptInput {
  title?: string;
  description?: string | null;
  category?: TaskCategory;
  tags?: string[];
  targetModel?: string | null;
  isFavourite?: boolean;
  archived?: boolean;
}

export async function updatePrompt(db: DbOrTx, userId: string, promptId: string, input: UpdatePromptInput): Promise<Prompt> {
  const set: Partial<typeof prompts.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = cleanTitle(input.title, "");
  if (input.description !== undefined) set.description = cleanDescription(input.description);
  if (input.category !== undefined) set.category = input.category;
  if (input.tags !== undefined) set.tags = cleanTags(input.tags);
  if (input.targetModel !== undefined) set.targetModel = checkTargetModel(input.targetModel);
  if (input.isFavourite !== undefined) set.isFavourite = input.isFavourite;
  if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;

  const [updated] = await db
    .update(prompts)
    .set(set)
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
    .returning();
  if (!updated) throw notFound("Prompt");
  invalidateDashboard(userId);
  if (input.targetModel !== undefined) {
    await refreshPromptStats(db, promptId);
    return (await db.query.prompts.findFirst({ where: eq(prompts.id, promptId) })) ?? updated;
  }
  return updated;
}

/**
 * Delete a prompt. Versions, analyses, suggestions and estimates go with it
 * (cascades); optimisation runs and usage records keep their metadata with the
 * prompt reference cleared (billing/audit retention, docs/privacy-data-handling.md).
 */
export async function deletePrompt(db: DbOrTx, userId: string, promptId: string): Promise<void> {
  const deleted = await db
    .delete(prompts)
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
    .returning({ id: prompts.id });
  if (deleted.length === 0) throw notFound("Prompt");
  invalidateDashboard(userId);
}

export async function countPrompts(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(prompts)
    .where(and(eq(prompts.userId, userId), isNull(prompts.archivedAt)));
  return Number(rows[0]?.total ?? 0);
}

export function serialiseVersion(v: PromptVersion) {
  return {
    id: v.id,
    prompt_id: v.promptId,
    version_number: v.versionNumber,
    parent_version_id: v.parentVersionId,
    provenance: v.provenance,
    prompt_text: v.promptText,
    change_summary: v.changeSummary,
    token_estimate: v.tokenEstimate,
    token_estimate_method: v.tokenEstimateMethod,
    tokenizer_version: v.tokenizerVersion,
    optimisation_run_id: v.optimisationRunId,
    created_at: v.createdAt.toISOString(),
  };
}

export function serialisePrompt(p: Prompt) {
  const saved = p.originalTokenCount !== null && p.currentTokenCount !== null ? p.originalTokenCount - p.currentTokenCount : null;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    tags: p.tags,
    target_model: p.targetModel,
    is_favourite: p.isFavourite,
    archived_at: p.archivedAt?.toISOString() ?? null,
    current_version_id: p.currentVersionId,
    current_version_number: p.currentVersionNumber,
    original_token_count: p.originalTokenCount,
    current_token_count: p.currentTokenCount,
    /** Current version vs version 1, same tokenizer. Negative = longer. Estimate. */
    tokens_saved: saved,
    reduction_percent: saved !== null && p.originalTokenCount ? Math.round((saved / p.originalTokenCount) * 1000) / 10 : saved === null ? null : 0,
    optimisation_count: p.optimisationCount,
    latest_optimisation_status: p.latestOptimisationStatus,
    latest_quality_score: p.latestQualityScore,
    latest_analysis_at: p.latestAnalysisAt?.toISOString() ?? null,
    pending_suggestion_count: p.pendingSuggestionCount,
    pending_priority: (["none", "low", "medium", "high"] as const)[p.pendingPriority] ?? "none",
    /** Estimated input cost of the current text on the target model (no output assumption). */
    latest_estimated_input_cost: p.latestEstimatedCost === null ? null : Number(p.latestEstimatedCost),
    latest_pricing_version: p.latestPricingVersion,
    use_count: p.useCount,
    last_used_at: p.lastUsedAt?.toISOString() ?? null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export type SerialisedPrompt = ReturnType<typeof serialisePrompt>;
export type SerialisedVersion = ReturnType<typeof serialiseVersion>;
