import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { CATEGORY_LABELS, type TaskCategory } from "@/lib/categories";
import { formatMoney } from "@/lib/money";
import { db } from "@/lib/db/client";
import { getDashboardAnalytics, getDashboardSummary } from "@/lib/services/dashboard";
import { formatDateTime, formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Token & cost analytics" };

const MODE_LABELS: Record<string, string> = { balanced: "Balanced", token_saver: "Token saver", quality_first: "Quality first", custom: "Custom" };
const REQUEST_LABELS: Record<string, string> = { prompt_optimisation: "Optimisations", prompt_analysis: "Analyses" };

export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const [a, s] = await Promise.all([getDashboardAnalytics(db, user.id), getDashboardSummary(db, user.id)]);
  const st = a.suggestions.by_status;
  const decided = (st.accepted ?? 0) + (st.applied ?? 0) + (st.dismissed ?? 0);

  return (
    <div className="space-y-8">
      <div>
        <h1>Token &amp; cost analytics</h1>
        <p className="mt-2 text-ink-soft">How your prompts have changed. Figures marked estimate are counted from text; figures marked actual are what the provider reported for PromptIQ&apos;s own calls.</p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-5">
          <p className="text-sm text-ink-soft">Prompts analysed</p>
          <p className="mt-1 text-2xl">{formatNumber(a.prompts_analysed)}</p>
          <p className="text-sm text-ink-soft">{formatNumber(a.analyses_completed)} analyses</p>
        </div>
        <div className="panel p-5">
          <p className="text-sm text-ink-soft">Suggestions</p>
          <p className="mt-1 text-2xl">{formatNumber((st.accepted ?? 0) + (st.applied ?? 0))} accepted</p>
          <p className="text-sm text-ink-soft">
            {formatNumber(st.dismissed ?? 0)} dismissed, {formatNumber(st.pending ?? 0)} pending
            {decided ? `, ${Math.round((((st.accepted ?? 0) + (st.applied ?? 0)) / decided) * 100)}% acceptance` : ""}
          </p>
        </div>
        <div className="panel p-5">
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            Net tokens saved <Badge tone="estimate">estimate</Badge>
          </p>
          <p className="mt-1 text-2xl">{formatNumber(s.tokens_saved.net_tokens_saved)}</p>
          <p className="text-sm text-ink-soft">once per prompt, current vs original</p>
        </div>
        <div className="panel p-5">
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            Average reduction <Badge tone="estimate">estimate</Badge>
          </p>
          <p className="mt-1 text-2xl">{a.per_prompt.average_reduction_percent === null ? "—" : `${a.per_prompt.average_reduction_percent}%`}</p>
          <p className="text-sm text-ink-soft">across {formatNumber(a.per_prompt.prompts_with_new_versions)} prompts with new versions</p>
        </div>
      </section>
      <p className="text-sm text-ink-faint">{a.per_prompt.definition}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="text-base">Optimisation runs by mode</h2>
          <p className="mt-1 text-sm text-ink-faint">{a.optimisation_runs.definition}</p>
          {a.optimisation_runs.by_mode.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No optimisations yet.</p>
          ) : (
            <table className="table mt-3">
              <thead>
                <tr>
                  <th scope="col">Mode</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Average change</th>
                </tr>
              </thead>
              <tbody>
                {a.optimisation_runs.by_mode.map((m) => (
                  <tr key={m.mode}>
                    <td>{MODE_LABELS[m.mode] ?? m.mode}</td>
                    <td>{formatNumber(m.runs)}</td>
                    <td>{m.average_reduction_percent === null ? "—" : m.average_reduction_percent >= 0 ? `${m.average_reduction_percent}% fewer tokens` : `${-m.average_reduction_percent}% more tokens`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel p-5">
          <h2 className="text-base">Suggestion categories</h2>
          {Object.keys(a.suggestions.by_category).length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No suggestions yet.</p>
          ) : (
            <table className="table mt-3">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Dismissed</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(a.suggestions.by_category)
                  .sort((x, y) => y[1].total - x[1].total)
                  .map(([key, c]) => (
                    <tr key={key}>
                      <td>{c.label}</td>
                      <td>{formatNumber(c.accepted)}</td>
                      <td>{formatNumber(c.dismissed)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-sm text-ink-faint">
            Your decisions tailor future suggestions. Manage this in <Link href="/app/preferences">Preferences</Link>.
          </p>
        </section>

        <section className="panel p-5">
          <h2 className="flex items-center gap-2 text-base">
            PromptIQ usage, last 30 days <Badge tone="accent">actual</Badge>
          </h2>
          {a.promptiq_usage_last_30_days.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No AI calls yet.</p>
          ) : (
            <table className="table mt-3">
              <thead>
                <tr>
                  <th scope="col">Calls</th>
                  <th scope="col">Count</th>
                  <th scope="col">Tokens in / out</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {a.promptiq_usage_last_30_days.map((u) => (
                  <tr key={u.request_type}>
                    <td>{REQUEST_LABELS[u.request_type] ?? u.request_type}</td>
                    <td>{formatNumber(u.calls)}</td>
                    <td>
                      {formatNumber(u.input_tokens)} / {formatNumber(u.output_tokens)}
                    </td>
                    <td>{u.actual_cost === null ? "no pricing" : formatMoney(u.actual_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-sm text-ink-faint">Reported by the provider for PromptIQ&apos;s own requests. Running your prompts in ChatGPT or other tools is not included.</p>
        </section>

        <section className="panel p-5">
          <h2 className="text-base">Top categories</h2>
          <ul className="mt-3 space-y-1 text-[0.9375rem]">
            {a.top_categories.length === 0 ? <li className="text-ink-soft">No prompts yet.</li> : null}
            {a.top_categories.map((c) => (
              <li key={c.category} className="flex justify-between">
                <Link href={`/app/library?category=${c.category}`}>{CATEGORY_LABELS[c.category as TaskCategory] ?? c.category}</Link>
                <span>{formatNumber(c.prompts)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel p-5">
        <h2 className="text-base">Recent activity</h2>
        {a.recent_activity.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">Nothing yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {a.recent_activity.map((e, i) => (
              <li key={`${e.type}-${e.at}-${i}`} className="flex flex-wrap justify-between gap-2 py-2 text-[0.9375rem]">
                <span>
                  <Link href={`/app/library/${e.prompt_id}`}>{e.prompt_title}</Link>: {e.detail}
                </span>
                <span className="text-sm text-ink-soft">{formatDateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
