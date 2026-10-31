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

export { describeChange, formatMoney } from "@/lib/money";
