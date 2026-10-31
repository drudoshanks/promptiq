import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RowActions } from "@/components/library/row-actions";
import { Badge, ProvenanceBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { CATEGORY_LABELS, isTaskCategory, TASK_CATEGORIES, type TaskCategory } from "@/lib/categories";
import { findSupportedModel, isSupportedModel, selectableModels } from "@/lib/config/models";
import { db } from "@/lib/db/client";
import { LIBRARY_SORTS, listPrompts, serialisePrompt, type LibrarySort } from "@/lib/services/prompts";
import { formatDate, formatNumber, truncate } from "@/lib/utils";

export const metadata: Metadata = { title: "My prompts" };

interface LibrarySearchParams {
  q?: string;
  category?: string;
  tag?: string;
  model?: string;
  favourite?: string;
  optimisation?: string;
  priority?: string;
  sort?: string;
  archived?: string;
  page?: string;
}

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: "Most recent",
  oldest: "Oldest",
  most_used: "Most used",
  largest: "Largest token count",
  most_saved: "Most tokens saved",
  attention: "Needs attention",
};

const STATUS_TEXT: Record<string, string> = {
  succeeded: "Optimised",
  failed: "Last optimisation failed",
  refused: "Optimisation declined",
  incomplete: "Incomplete optimisation",
  queued: "Optimising",
};

export default async function LibraryPage({ searchParams }: { searchParams: Promise<LibrarySearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const category = isTaskCategory(params.category) ? params.category : undefined;
  const sort = (LIBRARY_SORTS as readonly string[]).includes(params.sort ?? "") ? (params.sort as LibrarySort) : "recent";
  const optimisation = params.optimisation === "optimised" || params.optimisation === "not_optimised" ? params.optimisation : undefined;
  const priority = params.priority === "attention" || params.priority === "high" || params.priority === "medium" ? params.priority : undefined;
  const model = params.model && isSupportedModel(params.model) ? params.model : undefined;

  const result = await listPrompts(db, user.id, {
    search: params.q,
    category,
    tag: params.tag,
    targetModel: model,
    favourite: params.favourite === "1",
    optimisation,
    priority,
    sort,
    archivedOnly: params.archived === "only",
    page,
    pageSize: 20,
  });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hasFilters = Boolean(params.q || category || params.tag || model || params.favourite || optimisation || priority || params.archived);

  const query = (overrides: Partial<LibrarySearchParams>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...overrides })) if (v) next.set(k, v);
    const s = next.toString();
    return `/app/library${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>My prompts</h1>
          <p className="mt-2 text-ink-soft">
            {formatNumber(result.total)} {result.total === 1 ? "prompt" : "prompts"}
            {params.archived === "only" ? " in the archive" : ""}. Private to you; never used to train models.
          </p>
        </div>
        <LinkButton href="/app/studio" variant="primary">
          New prompt
        </LinkButton>
      </div>

      <form method="get" action="/app/library" className="panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Search and filter prompts">
        <div className="sm:col-span-2">
          <label htmlFor="q" className="field-label">
            Search
          </label>
          <input id="q" name="q" className="input" defaultValue={params.q ?? ""} placeholder="Title, prompt text or tag" />
        </div>
        <div>
          <label htmlFor="category" className="field-label">
            Category
          </label>
          <select id="category" name="category" className="select" defaultValue={category ?? ""}>
            <option value="">All categories</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="model" className="field-label">
            Target model
          </label>
          <select id="model" name="model" className="select" defaultValue={model ?? ""}>
            <option value="">Any model</option>
            {selectableModels().map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="optimisation" className="field-label">
            Optimisation
          </label>
          <select id="optimisation" name="optimisation" className="select" defaultValue={optimisation ?? ""}>
            <option value="">Any</option>
            <option value="optimised">Optimised</option>
            <option value="not_optimised">Not optimised yet</option>
          </select>
        </div>
        <div>
          <label htmlFor="priority" className="field-label">
            Improvement priority
          </label>
          <select id="priority" name="priority" className="select" defaultValue={priority ?? ""}>
            <option value="">Any</option>
            <option value="attention">Needs attention</option>
            <option value="high">High-priority suggestions</option>
            <option value="medium">Medium or higher</option>
          </select>
        </div>
        <div>
          <label htmlFor="sort" className="field-label">
            Sort by
          </label>
          <select id="sort" name="sort" className="select" defaultValue={sort}>
            {LIBRARY_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 pb-2 text-[0.9375rem]">
            <input type="checkbox" name="favourite" value="1" defaultChecked={params.favourite === "1"} /> Favourites
          </label>
          <label className="flex items-center gap-2 pb-2 text-[0.9375rem]">
            <input type="checkbox" name="archived" value="only" defaultChecked={params.archived === "only"} /> Archive
          </label>
        </div>
        {params.tag ? <input type="hidden" name="tag" value={params.tag} /> : null}
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <button type="submit" className="btn btn-secondary">
            Apply
          </button>
          {hasFilters ? (
            <Link href="/app/library" className="btn btn-ghost">
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      {params.tag ? (
        <p className="text-sm text-ink-soft">
          Tagged <span className="badge">{params.tag}</span> <Link href={query({ tag: undefined, page: undefined })}>remove</Link>
        </p>
      ) : null}

      {result.items.length === 0 ? (
        <div className="panel-soft p-10 text-center">
          <p className="text-ink-soft">{hasFilters ? "No prompts match these filters." : "Your library is empty. Optimise a prompt with auto-save on, or save one from the studio."}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {result.items.map((item) => {
            const p = serialisePrompt(item);
            const modelLabel = p.target_model ? (findSupportedModel(p.target_model)?.label ?? p.target_model) : null;
            return (
              <li key={p.id} className="panel p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/app/library/${p.id}`} className="font-medium no-underline hover:underline">
                      {p.title}
                    </Link>
                    {item.latestVersion ? (
                      <p className="prompt-text mt-2 text-ink-soft" style={{ whiteSpace: "normal" }}>
                        {truncate(item.latestVersion.promptText, 200)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
                    <span className="badge">{CATEGORY_LABELS[p.category as TaskCategory] ?? p.category}</span>
                    {modelLabel ? <span className="badge">{modelLabel}</span> : null}
                    {p.archived_at ? <span className="badge">Archived</span> : null}
                  </div>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-soft">
                  <div className="flex gap-1">
                    <dt>Tokens</dt>
                    <dd className="text-ink">{p.current_token_count === null ? "—" : formatNumber(p.current_token_count)}</dd>
                  </div>
                  {p.tokens_saved !== null && p.current_version_number > 1 ? (
                    <div className="flex gap-1">
                      <dt>vs original</dt>
                      <dd className={p.tokens_saved < 0 ? "text-estimate" : "text-ink"}>
                        {p.tokens_saved === 0 ? "no change" : p.tokens_saved > 0 ? `${formatNumber(p.tokens_saved)} fewer (${p.reduction_percent}%)` : `${formatNumber(-p.tokens_saved)} more`}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex gap-1">
                    <dt>Status</dt>
                    <dd className="text-ink">
                      {p.pending_suggestion_count > 0
                        ? `${p.pending_suggestion_count} suggestion${p.pending_suggestion_count > 1 ? "s" : ""} to review`
                        : p.latest_optimisation_status
                          ? (STATUS_TEXT[p.latest_optimisation_status] ?? p.latest_optimisation_status)
                          : p.latest_quality_score !== null
                            ? "Analysed"
                            : "Not analysed"}
                    </dd>
                  </div>
                  {p.latest_quality_score !== null ? (
                    <div className="flex gap-1">
                      <dt>Score</dt>
                      <dd className="text-ink" title="Heuristic indicator, not an objective measure">
                        {p.latest_quality_score}/100
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex gap-1">
                    <dt>Modified</dt>
                    <dd className="text-ink">{formatDate(p.updated_at)}</dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  {item.latestVersion ? <ProvenanceBadge provenance={item.latestVersion.provenance} /> : null}
                  <span className="text-ink-soft">Version {p.current_version_number}</span>
                  {p.pending_priority === "high" ? <Badge tone="danger">high priority</Badge> : null}
                  {p.tags.map((tag) => (
                    <Link key={tag} href={query({ tag, page: undefined })} className="badge no-underline">
                      {tag}
                    </Link>
                  ))}
                </div>
                <div className="mt-3 border-t border-line pt-2">
                  <RowActions id={p.id} title={p.title} isFavourite={p.is_favourite} archived={Boolean(p.archived_at)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={query({ page: String(page - 1) })}>Previous page</Link> : <span />}
          <span className="text-ink-soft">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={query({ page: String(page + 1) })}>Next page</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
