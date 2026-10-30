"use client";

import type { OutputLengthPreset } from "@/lib/config/estimates";
import type { TokenComparisonResult, TokenEstimateResult } from "@/lib/services/estimates";

import { api } from "./api";

export type { ModelOption, TokenComparisonResult, TokenEstimateResult } from "@/lib/services/estimates";

export type ExpectedOutput = OutputLengthPreset | number;

export function fetchEstimate(input: { model: string; text: string; expectedOutput: ExpectedOutput; signal?: AbortSignal }) {
  return api<TokenEstimateResult>("/api/v1/token-estimates", {
    method: "POST",
    body: { model: input.model, text: input.text, expected_output: input.expectedOutput },
    signal: input.signal,
  });
}

export function fetchComparison(input: { model: string; original: string; optimised: string; expectedOutput: ExpectedOutput; signal?: AbortSignal }) {
  return api<TokenComparisonResult>("/api/v1/token-estimates", {
    method: "POST",
    body: { model: input.model, original_text: input.original, optimised_text: input.optimised, expected_output: input.expectedOutput },
    signal: input.signal,
  });
}

/**
 * Count the exact text about to be exported and store that estimate (§7:
 * "recalculate the final count before export"). Returns the count so the
 * caller can show it; the caller must export the same `text` it passed here.
 */
export function recordFinalEstimate(input: { model: string; text: string; expectedOutput: ExpectedOutput; runId?: string | null; promptVersionId?: string | null }) {
  return api<TokenEstimateResult>("/api/v1/token-estimates", {
    method: "POST",
    body: {
      model: input.model,
      text: input.text,
      expected_output: input.expectedOutput,
      record: { label: "final", run_id: input.runId ?? null, prompt_version_id: input.promptVersionId ?? null },
    },
  });
}

/**
 * Money with enough precision for prompt-sized costs: amounts under a cent are
 * shown to three significant digits ("$0.00000035"), never rounded to zero.
 */
export function formatMoney(value: number, currency = "USD"): string {
  const abs = Math.abs(value);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const body =
    abs === 0
      ? "0.00"
      : abs < 0.01
        ? abs.toLocaleString("en", { maximumSignificantDigits: 3, maximumFractionDigits: 12, useGrouping: false })
        : abs.toFixed(abs < 1 ? 4 : 2);
  return `${value < 0 ? "−" : ""}${symbol}${body}`;
}

/** "120 fewer (25% smaller)", "30 more (12.5% larger)" or "No change". */
export function describeChange(tokensSaved: number, reductionPercent: number): string {
  if (tokensSaved === 0) return "No change";
  const n = Math.abs(tokensSaved).toLocaleString("en");
  const pct = Math.abs(reductionPercent).toLocaleString("en", { maximumFractionDigits: 1 });
  return tokensSaved > 0 ? `${n} fewer (${pct}% smaller)` : `${n} more (${pct}% larger)`;
}
