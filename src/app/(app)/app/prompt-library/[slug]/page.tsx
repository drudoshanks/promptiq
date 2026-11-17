import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TemplateFiller } from "@/components/prompt-library/template-filler";
import { AppError } from "@/lib/api/errors";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { LIBRARY_CATEGORY_LABELS, type LibraryCategory } from "@/lib/prompt-library/categories";
import { getTemplate, relatedTemplates } from "@/lib/services/prompt-library";
import { formatNumber } from "@/lib/utils";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function load(slug: string) {
  if (!SLUG.test(slug) || slug.length > 80) return null;
  try {
    return await getTemplate(db, slug);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const t = await load((await params).slug);
  return { title: t ? `${t.title} · Prompt library` : "Prompt library" };
}

export default async function PromptTemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const t = await load((await params).slug);
  if (!t) notFound();
  const related = await relatedTemplates(db, t);
  const categoryLabel = LIBRARY_CATEGORY_LABELS[t.category as LibraryCategory];

  return (
    <div className="space-y-6">
      <Link href="/app/prompt-library" className="inline-flex items-center gap-1 text-sm no-underline hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Prompt library
      </Link>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/app/prompt-library?category=${t.category}`} className="badge no-underline">
            {categoryLabel}
          </Link>
          {t.featured ? <span className="badge badge-accent">Featured</span> : null}
          {t.useCount > 0 ? (
            <span className="text-xs text-ink-faint">
              Used {formatNumber(t.useCount)} {t.useCount === 1 ? "time" : "times"}
            </span>
          ) : null}
        </div>
        <h1 className="mt-3">{t.title}</h1>
        <p className="mt-2 max-w-3xl text-ink-soft">{t.description}</p>
        {t.tags.length ? (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
            {t.tags.map((tag) => (
              <li key={tag}>
                <Link href={`/app/prompt-library?q=${encodeURIComponent(tag)}`} className="badge no-underline">
                  {tag}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <TemplateFiller slug={t.slug} promptText={t.promptText} variables={t.variables} />

      <p className="text-xs text-ink-faint">
        {t.license === "CC0-1.0" ? (
          <>
            Source:{" "}
            <a href={t.sourceUrl ?? "https://github.com/f/awesome-chatgpt-prompts"} target="_blank" rel="noopener noreferrer">
              awesome-chatgpt-prompts
            </a>
            {t.author ? ` (contributed by ${t.author})` : ""}, dedicated to the public domain under{" "}
            <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener noreferrer">
              CC0 1.0
            </a>
            . Lightly reviewed by PromptIQ.
          </>
        ) : (
          <>Written by the PromptIQ team at iMarwar. Free to use and adapt.</>
        )}
      </p>

      {related.length ? (
        <section aria-labelledby="related-heading">
          <h2 id="related-heading" className="text-lg font-semibold">
            More in {categoryLabel}
          </h2>
          <ul className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {related.map((r) => (
              <li key={r.slug}>
                <Link href={`/app/prompt-library/${r.slug}`} className="panel lib-card">
                  <h3 className="text-[0.9375rem] leading-snug font-semibold">{r.title}</h3>
                  <p className="line-clamp-2 text-sm text-ink-soft">{r.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
