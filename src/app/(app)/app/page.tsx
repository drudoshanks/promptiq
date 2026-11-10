import { ArrowRight, BookmarkCheck, Layers, Lightbulb, Library, Sparkles, TrendingUp } from "lucide-react";
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

function Stat({ label, value, note, href, icon: Icon }: { label: string; value: string; note?: React.ReactNode; href?: string; icon: typeof Library }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-ink-soft">{label}</p>
        <span className="icon-tile h-10 w-10 rounded-xl">
          <Icon aria-hidden="true" />
        </span>
      </div>
      <p className="mt-2 text-[2rem] font-extrabold leading-none tracking-[-0.04em] tabular-nums">{value}</p>
      {note ? <div className="mt-2 text-sm text-ink-soft">{note}</div> : null}
    </>
  );
  return href ? (
    <Link href={href} className="panel block p-5 no-underline transition-transform hover:-translate-y-0.5 hover:border-line-strong">
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
      <section className="relative overflow-hidden rounded-[28px] bg-ink p-7 text-white shadow-[var(--shadow-pop)] sm:p-9">
        <div aria-hidden="true" className="absolute -right-20 -top-24 h-80 w-80 rounded-full bg-brand/35 blur-3xl" />
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="eyebrow text-white/55">Overview</p>
            <h1 className="mt-3 text-white">{user.displayName ? <>Hello, <span className="text-brand-gradient">{user.displayName.split(" ")[0]}</span></> : "Welcome back"}</h1>
            <p className="mt-3 text-white/70">
              Your private prompt library. {user.historyEnabled ? "Auto-save is on: prompts you optimise are saved here." : "Auto-save is off: save prompts from the studio when you want to keep them."}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <LinkButton href="/app/studio" variant="primary">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Open the studio
              </LinkButton>
              <Link href="/app/library" className="btn border-white/20 bg-white/5 text-white hover:bg-white/10">
                <Library className="h-4 w-4" aria-hidden="true" />
                My prompts
              </Link>
            </div>
          </div>
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-white/80">Optimisations this period</p>
              <Link href="/app/usage" className="text-[0.8125rem] font-semibold text-brand-light no-underline hover:underline">
                Usage and plan
              </Link>
            </div>
            <p className="mt-2 text-[1.75rem] font-extrabold tracking-[-0.03em] tabular-nums">
              {formatNumber(usage.used)} <span className="text-base font-semibold text-white/50">of {formatNumber(usage.limit)}</span>
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-gradient-to-r from-brand-light to-accent" style={{ width: `${Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100))}%` }} />
            </div>
            <Link href="/app/studio" className="mt-4 flex items-center gap-2 text-sm font-semibold text-white/80 no-underline hover:text-white">
              <Layers className="h-4 w-4 text-brand-light" aria-hidden="true" />
              New: break big prompts into steps
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {summary.total_prompts === 0 ? (
        <div className="panel-soft p-8 text-center">
          <p className="text-ink-soft">Your library is empty. Improve a prompt and save the result, and it will appear here with suggestions and token figures.</p>
          <div className="mt-4">
            <LinkButton href="/app/studio" variant="primary">
              Improve a prompt
            </LinkButton>
          </div>
        </div>
      ) : null}

      <section aria-label="Library summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Library} label="Saved prompts" value={formatNumber(summary.total_prompts)} note={`${formatNumber(summary.favourites)} favourites`} href="/app/library" />
        <Stat icon={TrendingUp} label="Optimised" value={formatNumber(summary.prompts_optimised)} note="prompts with a newer version than the original" href="/app/library?optimisation=optimised" />
        <Stat icon={BookmarkCheck} label="Need improvement" value={formatNumber(summary.prompts_needing_improvement)} note="high or medium suggestions pending, or a low score" href="/app/library?priority=attention&sort=attention" />
        <Stat icon={Lightbulb} label="Pending suggestions" value={formatNumber(summary.pending_suggestions)} note={`across ${formatNumber(summary.prompts_with_pending_suggestions)} prompts`} href="/app/suggestions" />
      </section>

      <section aria-labelledby="savings-heading" className="grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="savings-heading" className="text-base">
              Tokens saved
            </h2>
            <Badge tone="estimate">estimate</Badge>
          </div>
          <p className="mt-2 text-2xl font-extrabold tracking-[-0.035em] tabular-nums">
            {saved.net_tokens_saved >= 0 ? formatNumber(saved.net_tokens_saved) : `${formatNumber(-saved.net_tokens_saved)} more`}
            <span className="ml-2 text-base font-medium tracking-normal text-ink-faint">tokens net</span>
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
          <p className="mt-2 text-2xl font-extrabold tracking-[-0.035em] tabular-nums">
            {formatMoney(Math.abs(cost.estimated_input_cost_saved_per_request))}
            <span className="ml-2 text-base font-medium tracking-normal text-ink-faint">{cost.estimated_input_cost_saved_per_request >= 0 ? "less" : "more"} per run of each prompt</span>
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
            <Link href="/app/library?sort=most_used" className="text-sm font-semibold text-accent-deep no-underline hover:underline">
              Most used
            </Link>
          </div>
          {summary.recently_used.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">Nothing yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {summary.recently_used.map((p) => (
                <li key={p.id} className="panel flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:border-line-strong">
                  <Link href={`/app/library/${p.id}`} className="min-w-0 truncate font-semibold no-underline hover:text-accent-deep">
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
            <Link href="/app/suggestions" className="text-sm font-semibold text-accent-deep no-underline hover:underline">
              All suggestions
            </Link>
          </div>
          {summary.prompts_with_pending.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No pending suggestions. Open a prompt and choose Analyse to get some.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {summary.prompts_with_pending.map((p) => (
                <li key={p.id} className="panel flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:border-line-strong">
                  <Link href={`/app/library/${p.id}#suggestions`} className="min-w-0 truncate font-semibold no-underline hover:text-accent-deep">
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

    </div>
  );
}
