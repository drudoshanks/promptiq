import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { formatMoney } from "@/lib/money";
import { db } from "@/lib/db/client";
import { listOptimisationHistory } from "@/lib/services/dashboard";
import { formatDateTime, formatNumber } from "@/lib/utils";

export const metadata: Metadata = { title: "Optimisation history" };

const MODE_LABELS: Record<string, string> = { balanced: "Balanced", token_saver: "Token saver", quality_first: "Quality first", custom: "Custom" };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const page = Math.max(1, Number((await searchParams).page ?? "1") || 1);
  const history = await listOptimisationHistory(db, user.id, page, 25);
  const pages = Math.max(1, Math.ceil(history.total / history.page_size));

  return (
    <div className="space-y-6">
      <div>
        <h1>Optimisation history</h1>
        <p className="mt-2 text-ink-soft">
          Every optimisation of a saved prompt. Token changes compare each run&apos;s proposal with the text it started from, counted with the target model&apos;s tokenizer (estimates).
        </p>
      </div>
      {history.items.length === 0 ? (
        <p className="panel-soft p-8 text-center text-ink-soft">No optimisations yet.</p>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Prompt</th>
                <th scope="col">Mode</th>
                <th scope="col">Target</th>
                <th scope="col">Tokens</th>
                <th scope="col">Input cost (est.)</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                  <td>
                    <Link href={`/app/library/${r.prompt_id}`}>{r.prompt_title}</Link>
                  </td>
                  <td>{MODE_LABELS[r.optimisation_mode] ?? r.optimisation_mode}</td>
                  <td>{r.target_model ?? "—"}</td>
                  <td className={r.tokens_saved !== null && r.tokens_saved < 0 ? "text-estimate" : undefined}>
                    {r.tokens_saved === null ? "—" : r.tokens_saved === 0 ? "no change" : r.tokens_saved > 0 ? `${formatNumber(r.tokens_saved)} fewer (${r.reduction_percent}%)` : `${formatNumber(-r.tokens_saved)} more (${Math.abs(r.reduction_percent ?? 0)}%)`}
                  </td>
                  <td>
                    {r.estimated_input_cost_before !== null && r.estimated_input_cost_after !== null
                      ? `${formatMoney(r.estimated_input_cost_before)} → ${formatMoney(r.estimated_input_cost_after)}`
                      : "no pricing"}
                  </td>
                  <td>
                    {r.status !== "succeeded" ? (
                      <Badge tone="danger">{r.status}</Badge>
                    ) : r.saved_as_version ? (
                      <Badge tone="accent">saved as version</Badge>
                    ) : (
                      <Badge>proposal not saved</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={`/app/history?page=${page - 1}`}>Previous page</Link> : <span />}
          <span className="text-ink-soft">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={`/app/history?page=${page + 1}`}>Next page</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
