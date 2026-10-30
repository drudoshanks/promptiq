import type { ProviderUsage } from "./types";

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Normalise the `usage` object of an OpenAI Responses API response
 * (`input_tokens`, `output_tokens`, `total_tokens`,
 * `input_tokens_details.cached_tokens`). Returns null when the provider did not
 * report usage — callers must then record "no usage", never derive it from a
 * text tokenizer.
 */
export function parseResponsesUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input = nonNegativeInt(usage["input_tokens"]);
  const output = nonNegativeInt(usage["output_tokens"]);
  if (input === null || output === null) return null;
  const details = usage["input_tokens_details"];
  const cached =
    details && typeof details === "object" ? nonNegativeInt((details as Record<string, unknown>)["cached_tokens"]) : null;
  const total = nonNegativeInt(usage["total_tokens"]) ?? input + output;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: cached === null ? null : Math.min(cached, input),
  };
}

/** Sum the usage of several attempts; null when none of them reported usage. */
export function sumUsage(usages: Array<ProviderUsage | null>): ProviderUsage | null {
  const reported = usages.filter((u): u is ProviderUsage => u !== null);
  if (reported.length === 0) return null;
  const anyCached = reported.some((u) => u.cachedInputTokens !== null);
  return reported.reduce<ProviderUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      cachedInputTokens: anyCached ? (acc.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0) : null,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: anyCached ? 0 : null },
  );
}
