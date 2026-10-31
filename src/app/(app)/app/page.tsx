import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { formatMoney } from "@/lib/money";
import { db } from "@/lib/db/client";
import { getDashboardSummary } from "@/lib/services/dashboard";
import { getUsageSummary } from "@/lib/services/usage";
import { formatDate, formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

function Stat({ label, value, note, href }: { label: string; value: string; note?: React.ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-ink-soft">{label}</p>
      <p className="mt-1 text-2xl">{value}</p>
      {note ? <div className="mt-1 text-sm text-ink-soft">{note}</div> : null}
    </>
  );
  return href ? (
    <Link href={href} className="panel block p-5 no-underline hover:border-line-strong">
      {body}
    </Link>
  ) : (
    <div className="panel p-5">{body}</div>
  );
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!user.onboardedAt) redirect("/app/onboarding");

  const [summary, usage] = await Promise.all([getDashboardSummary(db, user.id), getUsageSummary(db, user)]);
  const saved = summary.tokens_saved;
  const cost = summary.estimated_cost_savings;

  return (
    <div className="space-y-10">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>{user.displayName ? `Hello, ${user.displayName.split(" ")[0]}` : "Overview"}</h1>
          <p className="mt-2 text-ink-soft">
            Your private prompt library. {user.historyEnabled ? "Auto-save is on: prompts you optimise are saved here." : "Auto-save is off: save prompts from the studio when you want to keep them."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/app/intelligence" variant="primary">
            Improve a prompt
          </LinkButton>
          <LinkButton href="/app/studio">Quick studio</LinkButton>
        </div>
      </section>

      {summary.total_prompts === 0 ? (
        <div className="panel-soft p-8 text-center">
          <p className="text-ink-soft">Your library is empty. Improve a prompt and save the result, and it will appear here with suggestions and token figures.</p>
          <div className="mt-4">
            <LinkButton href="/app/intelligence" variant="primary">
              Improve a prompt
            </LinkButton>
          </div>
        </div>
      ) : null}

      <section aria-label="Library summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Saved prompts" value={formatNumber(summary.total_prompts)} note={`${formatNumber(summary.favourites)} favourites`} href="/app/library" />
        <Stat label="Optimised" value={formatNumber(summary.prompts_optimised)} note="prompts with a newer version than the original" href="/app/library?optimisation=optimised" />
        <Stat label="Need improvement" value={formatNumber(summary.prompts_needing_improvement)} note="high or medium suggestions pending, or a low score" href="/app/library?priority=attention&sort=attention" />
        <Stat label="Pending suggestions" value={formatNumber(summary.pending_suggestions)} note={`across ${formatNumber(summary.prompts_with_pending_suggestions)} prompts`} href="/app/suggestions" />
      </section>

      <section aria-labelledby="savings-heading" className="grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="savings-heading" className="text-base">
              Tokens saved
            </h2>
            <Badge tone="estimate">estimate</Badge>
          </div>
          <p className="mt-2 text-2xl">
            {saved.net_tokens_saved >= 0 ? formatNumber(saved.net_tokens_saved) : `${formatNumber(-saved.net_tokens_saved)} more`}
            <span className="ml-2 text-base text-ink-faint">tokens net</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {formatNumber(saved.prompts_reduced)} prompts shorter, {formatNumber(saved.prompts_increased)} longer than their originals.
          </p>
          <p className="mt-3 text-sm text-ink-faint">{saved.definition}</p>
        </div>
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base">Input cost difference</h2>
            <Badge tone="estimate">estimate</Badge>
          </div>
          <p className="mt-2 text-2xl">
            {formatMoney(Math.abs(cost.estimated_input_cost_saved_per_request))}
            <span className="ml-2 text-base text-ink-faint">{cost.estimated_input_cost_saved_per_request >= 0 ? "less" : "more"} per run of each prompt</span>
          </p>
          {!cost.complete ? (
            <p className="mt-1 text-sm text-estimate">Incomplete: no pricing for {cost.unpriced_models.join(", ")}.</p>
          ) : null}
          <p className="mt-3 text-sm text-ink-faint">{cost.note}</p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg">Recently used</h2>
            <Link href="/app/library?sort=most_used" className="text-sm">
              Most used
            </Link>
          </div>
          {summary.recently_used.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">Nothing yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {summary.recently_used.map((p) => (
                <li key={p.id} className="panel flex items-center justify-between gap-3 p-3">
                  <Link href={`/app/library/${p.id}`} className="min-w-0 truncate no-underline hover:underline">
                    {p.title}
                  </Link>
                  <span className="shrink-0 text-sm text-ink-soft">{p.last_used_at ? `used ${formatDate(p.last_used_at)}` : `edited ${formatDate(p.updated_at)}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg">Waiting for your review</h2>
            <Link href="/app/suggestions" className="text-sm">
              All suggestions
            </Link>
          </div>
          {summary.prompts_with_pending.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No pending suggestions. Open a prompt and choose Analyse to get some.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {summary.prompts_with_pending.map((p) => (
                <li key={p.id} className="panel flex items-center justify-between gap-3 p-3">
                  <Link href={`/app/library/${p.id}#suggestions`} className="min-w-0 truncate no-underline hover:underline">
                    {p.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-2 text-sm">
                    <Badge tone={p.pending_priority === "high" ? "danger" : "neutral"}>{p.pending_priority} priority</Badge>
                    {formatNumber(p.pending_suggestion_count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="text-sm text-ink-soft">
        {formatNumber(usage.used)} of {formatNumber(usage.limit)} optimisations used this period. <Link href="/app/usage">Usage and plan</Link>
      </p>
    </div>
  );
}
