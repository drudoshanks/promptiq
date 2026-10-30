/**
 * Model price table used for *estimated* provider cost (FR-014, §17.1).
 *
 * Prices are USD per 1M tokens and change without notice (A-09). Verify against
 * https://developers.openai.com/api/docs/pricing before release and keep this
 * table current; unknown models fall back to the conservative default so cost
 * accounting never silently reports zero.
 *
 * Last reviewed: 2026-10-30.
 */
export interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  /** Whether the model accepts the `reasoning.effort` parameter. */
  reasoning: boolean;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5-mini": { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0, reasoning: true },
  "gpt-5-nano": { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4, reasoning: true },
  "gpt-5.4-mini": { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5, reasoning: true },
  "gpt-5.4-nano": { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.25, reasoning: true },
  "gpt-5.4": { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15.0, reasoning: true },
  "gpt-4.1-mini": { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6, reasoning: false },
  "gpt-4.1-nano": { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4, reasoning: false },
};

/** Used when a configured model is not in the table: deliberately pessimistic. */
export const DEFAULT_MODEL_PRICE: ModelPrice = {
  inputPerMillion: 2.5,
  cachedInputPerMillion: 0.25,
  outputPerMillion: 15.0,
  reasoning: true,
};

export function priceForModel(modelId: string): { price: ModelPrice; known: boolean } {
  const exact = MODEL_PRICES[modelId];
  if (exact) return { price: exact, known: true };
  // Dated snapshots (e.g. gpt-5-mini-2025-08-07) share the base model's price.
  const base = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((key) => modelId.startsWith(key));
  if (base) return { price: MODEL_PRICES[base] as ModelPrice, known: true };
  return { price: DEFAULT_MODEL_PRICE, known: false };
}
