"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";

export interface PreservationView {
  status: "passed" | "needs_review" | "failed";
  checks: Array<{ id: string; kind: string; kind_label: string; text: string; essential: boolean; status: "preserved" | "changed" | "missing" | "contradicted"; method: string; note: string | null }>;
  preserved: number;
  changed: number;
  missing: number;
  contradicted: number;
  new_assumptions: string[];
  contradictions: string[];
  summary: string;
  disclaimer: string;
}

export const PRESERVATION_BADGE: Record<PreservationView["status"], { tone: "accent" | "warn" | "danger"; label: string }> = {
  passed: { tone: "accent", label: "Requirements kept" },
  needs_review: { tone: "warn", label: "Review changes" },
  failed: { tone: "danger", label: "Requirements lost" },
};

const ICON = {
  preserved: <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden="true" />,
  changed: <CircleDashed className="h-4 w-4 text-warn" aria-hidden="true" />,
  missing: <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />,
  contradicted: <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />,
};
const STATUS_LABEL = { preserved: "Kept", changed: "Reworded", missing: "Missing", contradicted: "Reversed" };

/** Requirement checklist: what the revision kept, changed, dropped or reversed. */
export function PreservationPanel({ report }: { report: PreservationView }) {
  const [showAll, setShowAll] = useState(report.status !== "passed");
  const badge = PRESERVATION_BADGE[report.status];
  const ordered = [...report.checks].sort((a, b) => order(a.status) - order(b.status));
  const visible = showAll ? ordered : ordered.filter((c) => c.status !== "preserved");
  return (
    <section aria-labelledby="preservation-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="preservation-heading" className="text-base">
          Requirement check
        </h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{report.summary}</p>

      {report.contradictions.length ? (
        <ul className="mt-3 space-y-1 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {report.contradictions.map((c) => (
            <li key={c}>Contradiction: {c}</li>
          ))}
        </ul>
      ) : null}

      {report.checks.length ? (
        <>
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {visible.map((c) => (
              <li key={c.id} className="flex gap-2.5 px-3 py-2 text-sm">
                <span className="mt-0.5">{ICON[c.status]}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words">{c.text.length > 220 ? `${c.text.slice(0, 219)}…` : c.text}</p>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-soft">
                    {STATUS_LABEL[c.status]} · {c.kind_label}
                    {c.essential ? "" : " (optional)"}
                    {c.method === "semantic" ? " · checked by meaning" : ""}
                    {c.note ? ` — ${c.note}` : ""}
                  </p>
                </div>
              </li>
            ))}
            {visible.length === 0 ? <li className="px-3 py-2 text-sm text-ink-soft">Every detected requirement is present.</li> : null}
          </ul>
          <button type="button" className="mt-2 text-sm text-accent-deep underline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide kept requirements" : `Show all ${report.checks.length} requirements`}
          </button>
        </>
      ) : null}

      {report.new_assumptions.length ? (
        <div className="mt-4">
          <p className="text-sm font-medium">New assumptions in the revision</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
            {report.new_assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 text-[0.8125rem] text-ink-faint">{report.disclaimer}</p>
    </section>
  );
}

function order(s: string) {
  return { contradicted: 0, missing: 1, changed: 2, preserved: 3 }[s] ?? 4;
}
