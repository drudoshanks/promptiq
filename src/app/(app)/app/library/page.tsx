import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ProvenanceBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { CATEGORY_LABELS, isTaskCategory, TASK_CATEGORIES, type TaskCategory } from "@/lib/categories";
import { db } from "@/lib/db/client";
import { listPrompts } from "@/lib/services/prompts";
import { formatDate, formatNumber, truncate } from "@/lib/utils";

export const metadata: Metadata = { title: "Library" };

interface LibrarySearchParams {
  q?: string;
  category?: string;
  tag?: string;
  page?: string;
  archived?: string;
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<LibrarySearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const category = isTaskCategory(params.category) ? params.category : undefined;
  const includeArchived = params.archived === "1";

  const result = await listPrompts(db, user.id, {
    search: params.q,
    category,
    tag: params.tag,
    includeArchived,
    page,
    pageSize: 20,
  });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hasFilters = Boolean(params.q || category || params.tag || includeArchived);

  const query = (overrides: Partial<LibrarySearchParams>) => {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return `/app/library${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Library</h1>
          <p className="mt-2 text-ink-soft">
            {formatNumber(result.total)} {result.total === 1 ? "prompt" : "prompts"}. Only you can see them.
          </p>
        </div>
        <LinkButton href="/app/studio" variant="primary">
          New optimisation
        </LinkButton>
      </div>

      <form method="get" action="/app/library" className="panel flex flex-wrap items-end gap-3 p-4" role="search">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="field-label">
            Search
          </label>
          <input id="q" name="q" className="input" defaultValue={params.q ?? ""} placeholder="Title or prompt text" />
        </div>
        <div>
          <label htmlFor="category" className="field-label">
            Category
          </label>
          <select id="category" name="category" className="select" defaultValue={category ?? ""}>
            <option value="">All</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-[0.9375rem]">
          <input type="checkbox" name="archived" value="1" defaultChecked={includeArchived} /> Include archived
        </label>
        {params.tag ? <input type="hidden" name="tag" value={params.tag} /> : null}
        <button type="submit" className="btn btn-secondary">
          Filter
        </button>
        {hasFilters ? (
          <Link href="/app/library" className="btn btn-ghost">
            Clear
          </Link>
        ) : null}
      </form>

      {params.tag ? (
        <p className="text-sm text-ink-soft">
          Showing prompts tagged <span className="badge">{params.tag}</span>{" "}
          <Link href={query({ tag: undefined })}>remove</Link>
        </p>
      ) : null}

      {result.items.length === 0 ? (
        <div className="panel-soft p-10 text-center">
          <p className="text-ink-soft">{hasFilters ? "No prompts match these filters." : "Your library is empty. Optimise a prompt, or save one from the studio."}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {result.items.map((item) => (
            <li key={item.id} className="panel p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/app/library/${item.id}`} className="font-medium no-underline hover:underline">
                    {item.title}
                  </Link>
                  {item.latestVersion ? (
                    <p className="prompt-text mt-2 text-ink-soft" style={{ whiteSpace: "normal" }}>
                      {truncate(item.latestVersion.promptText, 220)}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-2 text-sm text-ink-soft">
                  <span className="badge">{CATEGORY_LABELS[item.category as TaskCategory] ?? item.category}</span>
                  {item.archivedAt ? <span className="badge">Archived</span> : null}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                {item.latestVersion ? <ProvenanceBadge provenance={item.latestVersion.provenance} /> : null}
                <span>
                  {item.versionCount} {item.versionCount === 1 ? "version" : "versions"}, updated {formatDate(item.updatedAt)}
                </span>
                {item.tags.map((tag) => (
                  <Link key={tag} href={query({ tag, page: undefined })} className="badge no-underline">
                    {tag}
                  </Link>
                ))}
              </div>
            </li>
          ))}
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
