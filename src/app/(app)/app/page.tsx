import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ProvenanceBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { CATEGORY_LABELS, type TaskCategory } from "@/lib/categories";
import { db } from "@/lib/db/client";
import { listPrompts } from "@/lib/services/prompts";
import { countRunsForUser, getUsageSummary } from "@/lib/services/usage";
import { formatDate, formatNumber, truncate } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!user.onboardedAt) redirect("/app/onboarding");

  const [recent, usage, totalRuns] = await Promise.all([
    listPrompts(db, user.id, { pageSize: 6 }),
    getUsageSummary(db, user),
    countRunsForUser(db, user.id),
  ]);
  const percent = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <div className="space-y-10">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>{user.displayName ? `Hello, ${user.displayName.split(" ")[0]}` : "Overview"}</h1>
          <p className="mt-2 text-ink-soft">Paste a prompt, review the proposal, export the version you want.</p>
        </div>
        <LinkButton href="/app/studio" variant="primary">
          Open the studio
        </LinkButton>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel p-5">
          <p className="text-sm text-ink-soft">Optimisations this period</p>
          <p className="mt-1 text-2xl">
            {formatNumber(usage.used)} <span className="text-base text-ink-faint">of {formatNumber(usage.limit)}</span>
          </p>
          <div className="meter mt-3" role="meter" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used} aria-label="Optimisations used">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink-soft">Resets {formatDate(usage.period.end)}</p>
        </div>
        <div className="panel p-5">
          <p className="text-sm text-ink-soft">Saved prompts</p>
          <p className="mt-1 text-2xl">
            {formatNumber(recent.total)} <span className="text-base text-ink-faint">of {formatNumber(usage.plan.maxSavedPrompts)}</span>
          </p>
          <p className="mt-2 text-sm text-ink-soft">{user.historyEnabled ? "History is on: optimisations are saved automatically." : "History is off: save prompts yourself."}</p>
        </div>
        <div className="panel p-5">
          <p className="text-sm text-ink-soft">All-time optimisations</p>
          <p className="mt-1 text-2xl">{formatNumber(totalRuns)}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {usage.plan.name} plan. <Link href="/app/usage">See usage and billing</Link>
          </p>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2>Recent prompts</h2>
          <Link href="/app/library" className="text-sm">
            Open library
          </Link>
        </div>
        {recent.items.length === 0 ? (
          <div className="panel-soft mt-4 p-8 text-center">
            <p className="text-ink-soft">Nothing saved yet. Your first optimisation will appear here.</p>
            <div className="mt-4">
              <LinkButton href="/app/studio" variant="primary">
                Optimise a prompt
              </LinkButton>
            </div>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {recent.items.map((item) => (
              <li key={item.id} className="panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/app/library/${item.id}`} className="font-medium no-underline hover:underline">
                    {item.title}
                  </Link>
                  <span className="badge">{CATEGORY_LABELS[item.category as TaskCategory] ?? item.category}</span>
                </div>
                {item.latestVersion ? (
                  <p className="prompt-text mt-2 text-ink-soft" style={{ whiteSpace: "normal" }}>
                    {truncate(item.latestVersion.promptText, 160)}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                  {item.latestVersion ? <ProvenanceBadge provenance={item.latestVersion.provenance} /> : null}
                  <span>
                    {item.versionCount} {item.versionCount === 1 ? "version" : "versions"}, updated {formatDate(item.updatedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
