import { BookOpen, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { isLibraryCategory, LIBRARY_SORT_LABELS, LIBRARY_SORTS, type LibrarySort } from "@/lib/prompt-library/categories";
import { searchTemplates } from "@/lib/services/prompt-library";
import { formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Prompt library" };

interface Params {
  q?: string;
  category?: string;
  sort?: string;
  page?: string;
}

export default async function PromptLibraryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 200);
  const category = isLibraryCategory(params.category) ? params.category : null;
  const sort = (LIBRARY_SORTS as readonly string[]).includes(params.sort ?? "") ? (params.sort as LibrarySort) : null;
  const page = Math.min(1000, Math.max(1, Number(params.page ?? "1") || 1));

  const result = await searchTemplates(db, { q, category, sort, page });

  const href = (overrides: Partial<Params>) => {
    const next = new URLSearchParams();
    const merged: Params = { q: q || undefined, category: category ?? undefined, sort: sort ?? undefined, page: undefined, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return `/app/prompt-library${s ? `?${s}` : ""}`;
  };
  const sortOptions = LIBRARY_SORTS.filter((s) => s !== "relevant" || q);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="icon-tile" aria-hidden="true">
            <BookOpen />
          </span>
          <div>
            <h1>Prompt library</h1>
            <p className="mt-2 max-w-2xl text-ink-soft">
              {formatNumber(result.all_count)} ready-to-use prompts for everyday work: writing, coding, research, marketing, learning and more. Fill in the blanks, then copy it, open it in the Studio or save it to My prompts.
            </p>
          </div>
        </div>
      </div>

      <form method="get" action="/app/prompt-library" className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-end" role="search" aria-label="Search the Prompt library">
        <div className="flex-1">
          <label htmlFor="q" className="field-label">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
            <input id="q" name="q" type="search" className="input pl-9" defaultValue={q} placeholder="For example: cold email, code review, lesson plan, SEO" />
          </div>
        </div>
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <div className="sm:w-48">
          <label htmlFor="sort" className="field-label">
            Sort by
          </label>
          <select id="sort" name="sort" className="select" defaultValue={sort ?? ""}>
            <option value="">{q ? "Best match" : "Most used"}</option>
            {sortOptions.map((s) => (
              <option key={s} value={s}>
                {LIBRARY_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      <nav aria-label="Categories" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        <Link href={href({ category: undefined })} className="chip" aria-current={category === null ? "true" : undefined}>
          All <span className="chip-count">{formatNumber(result.all_count)}</span>
        </Link>
        {result.categories
          .filter((c) => c.count > 0 || c.id === category)
          .map((c) => (
            <Link key={c.id} href={href({ category: c.id })} className="chip" aria-current={category === c.id ? "true" : undefined}>
              {c.label} <span className="chip-count">{formatNumber(c.count)}</span>
            </Link>
          ))}
      </nav>

      <p className="text-sm text-ink-soft" aria-live="polite">
        {result.total === 0 ? "No prompts found" : `${formatNumber(result.total)} ${result.total === 1 ? "prompt" : "prompts"}`}
        {q ? (
          <>
            {" "}
            for <strong className="text-ink">“{q}”</strong>
          </>
        ) : null}
        {q || category ? (
          <>
            {" · "}
            <Link href="/app/prompt-library">Clear</Link>
          </>
        ) : null}
      </p>

      {result.items.length === 0 ? (
        <div className="panel-soft p-10 text-center">
          <p className="text-ink-soft">Nothing matches that yet. Try fewer or different words, or browse a category.</p>
          <p className="mt-3 text-sm text-ink-soft">
            Can&apos;t find it? Describe what you need in the <Link href="/app/studio">Studio</Link> and it will write the prompt for you.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {result.items.map((t) => (
            <li key={t.slug}>
              <Link href={`/app/prompt-library/${t.slug}`} className="panel lib-card">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge">{t.category_label}</span>
                  {t.featured ? <span className="badge badge-accent">Featured</span> : null}
                  {t.variables.length ? (
                    <span className="text-xs text-ink-faint">
                      {t.variables.length} {t.variables.length === 1 ? "blank" : "blanks"} to fill
                    </span>
                  ) : null}
                </div>
                <h2 className="text-base leading-snug font-semibold">{t.title}</h2>
                <p className="line-clamp-3 text-sm text-ink-soft">{t.description}</p>
                <p className="mt-auto pt-1 text-xs text-ink-faint">
                  {t.license === "CC0-1.0" ? "Public domain (CC0)" : "PromptIQ original"}
                  {t.use_count > 0 ? ` · used ${formatNumber(t.use_count)} ${t.use_count === 1 ? "time" : "times"}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {result.pages > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {result.page > 1 ? <Link href={href({ page: String(result.page - 1) })}>Previous page</Link> : <span />}
          <span className="text-ink-soft">
            Page {result.page} of {result.pages}
          </span>
          {result.page < result.pages ? <Link href={href({ page: String(result.page + 1) })}>Next page</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
