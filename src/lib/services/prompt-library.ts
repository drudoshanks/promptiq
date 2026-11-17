import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { AppError } from "@/lib/api/errors";
import type { TaskCategory } from "@/lib/categories";
import { planFor } from "@/lib/config/plans";
import { promptTemplates, type AppUser, type PromptTemplateRow } from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import { fillPrompt, isLibraryCategory, LIBRARY_CATEGORIES, LIBRARY_CATEGORY_LABELS, promptVariables, type LibraryCategory, type LibrarySort } from "@/lib/prompt-library/categories";

import { createPrompt } from "./prompts";

/**
 * Prompt library: a public catalogue of ready-to-use prompts. The content
 * comes from db/seed/prompt-library.json (original PromptIQ prompts plus
 * curated CC0 prompts) and is synced into prompt_templates by db:migrate.
 */
export interface LibrarySeedItem {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  prompt: string;
  source: "promptiq" | "awesome-chatgpt-prompts";
  source_url: string | null;
  license: "PromptIQ original" | "CC0-1.0";
  author: string | null;
  featured: boolean;
  sort_rank: number;
}

const hashOf = (i: LibrarySeedItem) => createHash("sha256").update(JSON.stringify([i.title, i.description, i.category, i.tags, i.prompt, i.source, i.source_url, i.license, i.author, i.featured, i.sort_rank])).digest("hex");

/**
 * Insert new entries, update changed ones (keeping their use counts) and hide
 * entries no longer in the seed. Idempotent: running it twice changes nothing.
 */
export async function syncPromptLibrary(db: DbOrTx, items: LibrarySeedItem[]): Promise<{ inserted: number; updated: number; hidden: number; unchanged: number }> {
  const slugs = new Set<string>();
  for (const i of items) {
    if (slugs.has(i.slug)) throw new Error(`Duplicate prompt library slug: ${i.slug}`);
    if (!isLibraryCategory(i.category)) throw new Error(`Unknown prompt library category "${i.category}" for ${i.slug}`);
    slugs.add(i.slug);
  }
  const existing = await db.select({ slug: promptTemplates.slug, hash: promptTemplates.contentHash, active: promptTemplates.isActive }).from(promptTemplates);
  const bySlug = new Map(existing.map((e) => [e.slug, e]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const i of items) {
    const values = {
      slug: i.slug,
      title: i.title,
      description: i.description,
      category: i.category,
      tags: i.tags,
      tagsText: i.tags.join(" "),
      promptText: i.prompt,
      variables: promptVariables(i.prompt),
      source: i.source,
      sourceUrl: i.source_url,
      license: i.license,
      author: i.author,
      featured: i.featured,
      sortRank: i.sort_rank,
      contentHash: hashOf(i),
      isActive: true,
    };
    const current = bySlug.get(i.slug);
    if (!current) {
      await db.insert(promptTemplates).values(values);
      inserted++;
    } else if (current.hash !== values.contentHash || !current.active) {
      await db.update(promptTemplates).set({ ...values, updatedAt: new Date() }).where(eq(promptTemplates.slug, i.slug));
      updated++;
    } else unchanged++;
  }
  const gone = existing.filter((e) => e.active && !slugs.has(e.slug)).map((e) => e.slug);
  if (gone.length) await db.update(promptTemplates).set({ isActive: false, updatedAt: new Date() }).where(inArray(promptTemplates.slug, gone));
  return { inserted, updated, hidden: gone.length, unchanged };
}

// ---------------------------------------------------------------------------
// Browsing and search
// ---------------------------------------------------------------------------
export const LIBRARY_PAGE_SIZE = 24;

export interface LibraryQuery {
  q?: string | null;
  category?: LibraryCategory | null;
  sort?: LibrarySort | null;
  page?: number;
  pageSize?: number;
}

const preview = (text: string) => (text.length > 240 ? `${text.slice(0, 237).replace(/\s+\S*$/, "")}…` : text);

export function serialiseTemplateSummary(t: PromptTemplateRow) {
  return {
    slug: t.slug,
    title: t.title,
    description: t.description,
    category: t.category as LibraryCategory,
    category_label: LIBRARY_CATEGORY_LABELS[t.category as LibraryCategory],
    tags: t.tags,
    variables: t.variables,
    preview: preview(t.promptText),
    source: t.source,
    license: t.license,
    featured: t.featured,
    use_count: t.useCount,
  };
}

export function serialiseTemplate(t: PromptTemplateRow) {
  return { ...serialiseTemplateSummary(t), prompt_text: t.promptText, source_url: t.sourceUrl, author: t.author };
}

export type TemplateSummary = ReturnType<typeof serialiseTemplateSummary>;
export type TemplateDetail = ReturnType<typeof serialiseTemplate>;

/** Search text: full-text match, or a substring of the title or tags (so "regex" and "SEO" both work). */
function searchCondition(q: string): SQL {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(${sql.raw("search")} @@ websearch_to_tsquery('english', ${q}) OR ${promptTemplates.title} ILIKE ${like} OR ${promptTemplates.tagsText} ILIKE ${like})`;
}

export async function searchTemplates(db: DbOrTx, query: LibraryQuery = {}) {
  const q = query.q?.trim().slice(0, 200) || null;
  const pageSize = Math.min(Math.max(query.pageSize ?? LIBRARY_PAGE_SIZE, 1), 60);
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const sort: LibrarySort = query.sort ?? (q ? "relevant" : "popular");

  const base: SQL[] = [eq(promptTemplates.isActive, true)];
  if (q) base.push(searchCondition(q));
  const where = and(...base, ...(query.category ? [eq(promptTemplates.category, query.category)] : []));

  const rank = q ? sql`ts_rank(${sql.raw("search")}, websearch_to_tsquery('english', ${q}))` : sql`0`;
  const order =
    sort === "az"
      ? [asc(sql`lower(${promptTemplates.title})`), asc(promptTemplates.sortRank)]
      : sort === "relevant" && q
        ? [desc(sql`(${promptTemplates.title} ILIKE ${`%${q}%`})`), desc(rank), desc(promptTemplates.featured), asc(promptTemplates.sortRank)]
        : [desc(promptTemplates.featured), desc(promptTemplates.useCount), asc(promptTemplates.sortRank)];

  const [rows, [{ total } = { total: 0 }], counts] = await Promise.all([
    db
      .select()
      .from(promptTemplates)
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(promptTemplates).where(where),
    // Category counts for the current search (ignoring the category filter), for the chips.
    db
      .select({ category: promptTemplates.category, n: sql<number>`count(*)::int` })
      .from(promptTemplates)
      .where(and(...base))
      .groupBy(promptTemplates.category),
  ]);
  const countBy = new Map(counts.map((c) => [c.category, Number(c.n)]));
  return {
    items: rows.map(serialiseTemplateSummary),
    total: Number(total),
    page,
    page_size: pageSize,
    pages: Math.max(1, Math.ceil(Number(total) / pageSize)),
    q,
    category: query.category ?? null,
    sort,
    categories: LIBRARY_CATEGORIES.map((c) => ({ id: c, label: LIBRARY_CATEGORY_LABELS[c], count: countBy.get(c) ?? 0 })),
    all_count: [...countBy.values()].reduce((a, b) => a + b, 0),
  };
}

export type LibrarySearchResult = Awaited<ReturnType<typeof searchTemplates>>;

export async function getTemplate(db: DbOrTx, slug: string): Promise<PromptTemplateRow> {
  const row = await db.query.promptTemplates.findFirst({ where: and(eq(promptTemplates.slug, slug), eq(promptTemplates.isActive, true)) });
  if (!row) throw new AppError("NOT_FOUND", "That prompt isn't in the library.");
  return row;
}

export async function relatedTemplates(db: DbOrTx, t: PromptTemplateRow, limit = 4): Promise<TemplateSummary[]> {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.isActive, true), eq(promptTemplates.category, t.category), sql`${promptTemplates.slug} <> ${t.slug}`))
    .orderBy(desc(promptTemplates.featured), desc(promptTemplates.useCount), asc(promptTemplates.sortRank))
    .limit(limit);
  return rows.map(serialiseTemplateSummary);
}

/** Count a use (copy, open in the Studio, or save). Best effort; never blocks the user. */
export async function recordTemplateUse(db: DbOrTx, slug: string): Promise<void> {
  await db.update(promptTemplates).set({ useCount: sql`${promptTemplates.useCount} + 1` }).where(and(eq(promptTemplates.slug, slug), eq(promptTemplates.isActive, true)));
}

const TO_TASK: Record<LibraryCategory, TaskCategory> = {
  writing: "writing",
  marketing: "writing",
  business: "planning",
  coding: "coding",
  data: "extraction",
  education: "general",
  research: "research",
  productivity: "planning",
  career: "writing",
  customer_support: "writing",
  personal: "general",
  creative: "writing",
  roles: "general",
};

/**
 * Copy a library prompt into the user's own prompts (My prompts), with any
 * blanks the user filled in. The copy is theirs to edit; the library entry
 * is unchanged.
 */
export async function saveTemplateToMyPrompts(db: Db, user: AppUser, slug: string, values: Record<string, string> = {}) {
  const t = await getTemplate(db, slug);
  const text = fillPrompt(t.promptText, values);
  const prompt = await createPrompt(db, user.id, planFor(user.planCode), {
    title: t.title.slice(0, 200),
    description: `${t.description} (From the Prompt library${t.license === "CC0-1.0" ? ", public domain" : ""}.)`.slice(0, 1000),
    category: TO_TASK[t.category as LibraryCategory] ?? "general",
    tags: ["library", t.category.replace(/_/g, "-")],
    versions: [{ promptText: text, provenance: "imported", changeSummary: ["Added from the Prompt library."] }],
  });
  await recordTemplateUse(db, slug);
  return { prompt_id: prompt.id, title: prompt.title };
}
