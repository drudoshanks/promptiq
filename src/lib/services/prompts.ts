import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import type { TaskCategory } from "@/lib/categories";
import type { PlanLimits } from "@/lib/config/plans";
import { promptVersions, prompts, type Prompt, type PromptVersion, type Provenance } from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import { estimateTokens } from "@/lib/tokens";

export interface NewVersionInput {
  promptText: string;
  provenance: Provenance;
  changeSummary?: string[];
  parentVersionId?: string | null;
}

export interface CreatePromptInput {
  title?: string;
  category: TaskCategory;
  tags?: string[];
  /** Versions to create in order; the first becomes version 1. */
  versions: NewVersionInput[];
}

export interface PromptWithVersions extends Prompt {
  versions: PromptVersion[];
}

function cleanTitle(title: string | undefined, fallbackText: string): string {
  const explicit = (title ?? "").trim().replace(/\s+/g, " ");
  if (explicit) return explicit.slice(0, 120);
  const firstLine = fallbackText.trim().split("\n")[0] ?? "";
  const derived = firstLine.replace(/\s+/g, " ").slice(0, 80).trim();
  return derived || "Untitled prompt";
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

/**
 * Create a prompt and its first version(s) in one transaction (FR-009, FR-018).
 * Version numbers are assigned inside the transaction so they are gap-free and
 * unique per prompt.
 */
export async function createPrompt(db: Db, userId: string, plan: PlanLimits, input: CreatePromptInput): Promise<PromptWithVersions> {
  if (input.versions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one version is required.");
  }
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
        category: input.category,
        tags: cleanTags(input.tags),
      })
      .returning();
    if (!prompt) throw new Error("Failed to create prompt");

    const versions: PromptVersion[] = [];
    let parentId: string | null = null;
    let versionNumber = 0;
    for (const v of input.versions.slice(0, plan.maxVersionsPerPrompt)) {
      versionNumber += 1;
      const estimate = estimateTokens(v.promptText);
      const parentForThis: string | null = v.parentVersionId === undefined ? parentId : v.parentVersionId;
      const [version]: PromptVersion[] = await tx
        .insert(promptVersions)
        .values({
          promptId: prompt.id,
          versionNumber,
          parentVersionId: parentForThis,
          provenance: v.provenance,
          promptText: v.promptText,
          changeSummary: v.changeSummary ?? [],
          tokenEstimate: estimate.tokens,
          tokenEstimateMethod: estimate.method,
        })
        .returning();
      if (!version) throw new Error("Failed to create version");
      versions.push(version);
      parentId = version.id;
    }
    return { ...prompt, versions };
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

    const estimate = estimateTokens(input.promptText);
    const [version] = await tx
      .insert(promptVersions)
      .values({
        promptId,
        versionNumber: latest + 1,
        parentVersionId: input.parentVersionId ?? null,
        provenance: input.provenance,
        promptText: input.promptText,
        changeSummary: input.changeSummary ?? [],
        tokenEstimate: estimate.tokens,
        tokenEstimateMethod: estimate.method,
      })
      .returning();
    if (!version) throw new Error("Failed to create version");

    await tx.update(prompts).set({ updatedAt: new Date() }).where(eq(prompts.id, promptId));
    return version;
  });
}

export interface ListPromptsOptions {
  search?: string;
  category?: TaskCategory;
  tag?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PromptListItem extends Prompt {
  versionCount: number;
  latestVersion: PromptVersion | null;
}

/** List the caller's prompts with keyword search (PostgreSQL full-text + ILIKE on titles). */
export async function listPrompts(db: DbOrTx, userId: string, options: ListPromptsOptions = {}): Promise<{ items: PromptListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20));
  const search = (options.search ?? "").trim().slice(0, 200);

  const conditions = [eq(prompts.userId, userId)];
  if (!options.includeArchived) conditions.push(isNull(prompts.archivedAt));
  if (options.category) conditions.push(eq(prompts.category, options.category));
  if (options.tag) conditions.push(sql`${options.tag} = ANY(${prompts.tags})`);
  if (search) {
    const textMatch = sql`EXISTS (
      SELECT 1 FROM ${promptVersions} v
      WHERE v.prompt_id = ${prompts.id}
        AND to_tsvector('english', v.prompt_text) @@ plainto_tsquery('english', ${search})
    )`;
    conditions.push(or(ilike(prompts.title, `%${search.replace(/[%_]/g, "\\$&")}%`), textMatch)!);
  }
  const where = and(...conditions);

  const countRows = await db.select({ total: count() }).from(prompts).where(where);
  const total = Number(countRows[0]?.total ?? 0);
  const rows = await db.query.prompts.findMany({
    where,
    orderBy: [desc(prompts.updatedAt)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    with: { versions: { orderBy: [desc(promptVersions.versionNumber)] } },
  });

  const items: PromptListItem[] = rows.map((row) => {
    const { versions, ...prompt } = row;
    return { ...prompt, versionCount: versions.length, latestVersion: versions[0] ?? null };
  });
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
  category?: TaskCategory;
  tags?: string[];
  archived?: boolean;
}

export async function updatePrompt(db: DbOrTx, userId: string, promptId: string, input: UpdatePromptInput): Promise<Prompt> {
  const set: Partial<typeof prompts.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = cleanTitle(input.title, "");
  if (input.category !== undefined) set.category = input.category;
  if (input.tags !== undefined) set.tags = cleanTags(input.tags);
  if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;

  const [updated] = await db
    .update(prompts)
    .set(set)
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
    .returning();
  if (!updated) throw notFound("Prompt");
  return updated;
}

export async function deletePrompt(db: DbOrTx, userId: string, promptId: string): Promise<void> {
  const deleted = await db
    .delete(prompts)
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, userId)))
    .returning({ id: prompts.id });
  if (deleted.length === 0) throw notFound("Prompt");
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
    created_at: v.createdAt.toISOString(),
  };
}

export function serialisePrompt(p: Prompt) {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    tags: p.tags,
    archived_at: p.archivedAt?.toISOString() ?? null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export type SerialisedPrompt = ReturnType<typeof serialisePrompt>;
export type SerialisedVersion = ReturnType<typeof serialiseVersion>;
