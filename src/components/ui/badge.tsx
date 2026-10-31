import type { ReactNode } from "react";

import { cx } from "@/lib/utils";

interface BadgeProps {
  tone?: "neutral" | "estimate" | "accent" | "danger" | "warn";
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Badge({ tone = "neutral", children, title, className }: BadgeProps) {
  return (
    <span className={cx("badge", tone !== "neutral" && `badge-${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

/** Honesty marker: every token count or cost that is not measured by the provider. */
export function EstimateBadge({ method }: { method?: string | null }) {
  const label = method?.startsWith("tokenizer") ? "estimate (tokenizer)" : "estimate";
  return (
    <Badge tone="estimate" title="Approximate. Exact counts depend on the model that eventually runs this prompt.">
      {label}
    </Badge>
  );
}

const PROVENANCE_LABELS: Record<string, string> = {
  original: "Original",
  ai_optimised: "AI suggestion",
  user_edited: "Your edit",
  imported: "Imported",
};

export function ProvenanceBadge({ provenance }: { provenance: string }) {
  return <Badge tone={provenance === "ai_optimised" ? "accent" : "neutral"}>{PROVENANCE_LABELS[provenance] ?? provenance}</Badge>;
}
