"use client";

import { useState } from "react";

import { cx } from "@/lib/utils";

export interface RubricDimensionView {
  key: string;
  label: string;
  weight: number;
  normalised_weight: number;
  score: number;
  applicable: boolean;
  evidence: string[];
}

/**
 * The rubric as one bar: each segment's width is the dimension's weight, its
 * fill is the dimension's score. So the bar shows at a glance both what the
 * score is made of and where it was lost.
 */
export function RubricBar({ overall, dimensions, note }: { overall: number; dimensions: RubricDimensionView[]; note: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const applicable = dimensions.filter((d) => d.applicable);
  return (
    <div>
      <div className="flex items-end gap-3">
        <p className="text-[2.75rem] leading-none font-semibold tracking-tight tabular-nums">{overall}</p>
        <div className="pb-1">
          <p className="text-sm font-medium">Completeness score</p>
          <p className="text-[0.8125rem] text-ink-soft">out of 100, weighted rubric</p>
        </div>
      </div>

      <div className="mt-4 flex h-9 gap-[3px]" role="img" aria-label={`Score ${overall} of 100. ${applicable.map((d) => `${d.label} ${Math.round(d.score * 100)}%`).join(", ")}.`}>
        {applicable.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => setOpen(open === d.key ? null : d.key)}
            className={cx("group relative overflow-hidden rounded-[5px] bg-sunken text-left focus-visible:outline-offset-1", open === d.key && "ring-2 ring-accent")}
            style={{ flexGrow: d.normalised_weight, flexBasis: 0 }}
            title={`${d.label}: ${Math.round(d.score * 100)}% (weight ${Math.round(d.normalised_weight * 100)}%)`}
            aria-expanded={open === d.key}
          >
            <span className={cx("absolute inset-y-0 left-0 transition-[width] duration-500", d.score >= 0.75 ? "bg-accent" : d.score >= 0.4 ? "bg-accent/60" : "bg-estimate/70")} style={{ width: `${Math.max(d.score * 100, 0)}%` }} />
            <span className="sr-only">{d.label}</span>
          </button>
        ))}
      </div>

      <ul className="mt-4 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {dimensions.map((d) => (
          <li key={d.key}>
            <button type="button" onClick={() => setOpen(open === d.key ? null : d.key)} className="flex w-full items-baseline justify-between gap-3 rounded-md px-1 py-1 text-left text-sm hover:bg-panel-soft" aria-expanded={open === d.key}>
              <span className={cx(!d.applicable && "text-ink-faint")}>
                {d.label}
                <span className="ml-1.5 text-[0.8125rem] text-ink-faint">{d.applicable ? `${Math.round(d.normalised_weight * 100)}%` : "not counted"}</span>
              </span>
              <span className={cx("font-medium tabular-nums", !d.applicable && "text-ink-faint")}>{d.applicable ? `${Math.round(d.score * 100)}` : "n/a"}</span>
            </button>
            {open === d.key ? (
              <ul className="mb-2 ml-1 space-y-0.5 border-l-2 border-line pl-3 text-[0.8125rem] text-ink-soft">
                {d.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[0.8125rem] text-ink-faint">{note}</p>
    </div>
  );
}
