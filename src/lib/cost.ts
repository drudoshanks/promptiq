import { priceForModel } from "@/lib/config/models";

export interface UsageTokens {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

/**
 * Estimated provider cost in USD for one API call (SRS §17.1):
 *   uncached_input/1M * input_rate + cached_input/1M * cached_rate + output/1M * output_rate
 * Returns a value rounded to 6 decimal places (matches NUMERIC(12,6)).
 */
export function estimateCostUsd(modelId: string, usage: UsageTokens): number {
  const { price } = priceForModel(modelId);
  const cached = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens));
  const uncached = Math.max(0, usage.inputTokens - cached);
  const output = Math.max(0, usage.outputTokens);
  const cost =
    (uncached / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * price.cachedInputPerMillion +
    (output / 1_000_000) * price.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function formatUsd(value: number, fractionDigits = 4): string {
  return `$${value.toFixed(fractionDigits)}`;
}
