import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SuggestionActions } from "@/components/suggestions/suggestion-actions";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { listSuggestions } from "@/lib/services/analysis";

export const metadata: Metadata = { title: "Suggestions" };

const TABS = [
  { key: "pending", label: "To review", statuses: ["pending"] as const },
  { key: "accepted", label: "Accepted, not yet applied", statuses: ["accepted"] as const },
  { key: "deferred", label: "Later", statuses: ["deferred"] as const },
  { key: "done", label: "Applied or dismissed", statuses: ["applied", "dismissed"] as const },
];

export default async function SuggestionsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { tab } = await searchParams;
  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  const items = await listSuggestions(db, user.id, { status: [...active.statuses], pageSize: 100 });

  const byPrompt = new Map<string, { title: string; items: typeof items }>();
  for (const s of items) {
    const group = byPrompt.get(s.prompt_id) ?? { title: s.prompt_title, items: [] };
    group.items.push(s);
    byPrompt.set(s.prompt_id, group);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1>Suggestions</h1>
        <p className="mt-2 text-ink-soft">Improvement ideas from analysing your saved prompts. Accepted suggestions are applied when you optimise the prompt and save the new version.</p>
      </div>
      <nav aria-label="Suggestion status" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Link key={t.key} href={`/app/suggestions?tab=${t.key}`} className="nav-link" aria-current={t.key === active.key ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {byPrompt.size === 0 ? (
        <div className="panel-soft p-8 text-center text-ink-soft">
          {active.key === "pending" ? (
            <p>
              Nothing to review. Open a prompt in <Link href="/app/library">My prompts</Link> and choose Analyse.
            </p>
          ) : (
            <p>No suggestions here.</p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {[...byPrompt].map(([promptId, group]) => (
            <section key={promptId} className="panel p-5" aria-label={group.title}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base">
                  <Link href={`/app/library/${promptId}#suggestions`} className="no-underline hover:underline">
                    {group.title}
                  </Link>
                </h2>
                <Link href={`/app/library/${promptId}#optimise`} className="text-sm">
                  Optimise with accepted suggestions
                </Link>
              </div>
              <ul className="mt-3 space-y-3">
                {group.items.map((s) => (
                  <li key={s.id} className="border-t border-line pt-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{s.title}</p>
                        <div className="mt-1 flex flex-wrap gap-2 text-sm">
                          <Badge tone={s.priority === "high" ? "danger" : "neutral"}>{s.priority}</Badge>
                          <Badge>{s.category_label}</Badge>
                        </div>
                      </div>
                      {s.status !== "applied" && s.status !== "dismissed" ? <SuggestionActions id={s.id} status={s.status} title={s.title} /> : <Badge>{s.status}</Badge>}
                    </div>
                    <p className="mt-2 text-[0.9375rem]">{s.explanation}</p>
                    <p className="mt-1 text-[0.9375rem] text-ink-soft">Suggested change: {s.recommendation}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
