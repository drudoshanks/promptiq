/**
 * Cost calculator (§5). Pure functions over a pricing snapshot; the snapshot
 * comes from the versioned model_pricing table (src/lib/services/pricing.ts).
 *
 *   input_cost  = input_tokens  × input_price_per_million  / 1,000,000
 *   output_cost = output_tokens × output_price_per_million / 1,000,000
 *   total       = input_cost + output_cost
 *
 * Cached input tokens (when the provider reports them) are priced at the cached
 * rate and subtracted from the uncached input. Results are rounded to 6 decimal
 * places (NUMERIC(16,10)). No pricing → no cost (never an invented rate).
 */
import { PRICING_STALE_AFTER_DAYS } from "@/lib/config/estimates";

export interface PricingSnapshot {
  provider: string;
  modelId: string;
  pricingVersion: string;
  currency: string;
  inputPerMillion: number;
  cachedInputPerMillion: number | null;
  outputPerMillion: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
  verifiedAt: Date;
}

export type PricingStatus = "current" | "stale" | "missing";

export interface CostBreakdown {
  input_cost: number;
  cached_input_cost: number;
  output_cost: number;
  total_cost: number;
  currency: string;
  pricing_version: string;
  pricing_status: PricingStatus;
  pricing_verified_at: string;
  calculated_at: string;
}

export interface CostTokens {
  inputTokens: number;
  cachedInputTokens?: number | null;
  outputTokens: number;
}

/** Costs are kept to 10 decimal places (NUMERIC(16,10)); prompt-sized costs are sub-micro-dollar. */
export const COST_SCALE = 10;

export function roundCost(value: number): number {
  return Number(value.toFixed(COST_SCALE));
}

export function pricingStatus(pricing: PricingSnapshot | null, now = new Date()): PricingStatus {
  if (!pricing) return "missing";
  const ageDays = (now.getTime() - pricing.verifiedAt.getTime()) / 86_400_000;
  return ageDays > PRICING_STALE_AFTER_DAYS ? "stale" : "current";
}

/** Cost of a request priced with the given snapshot; null when there is no snapshot. */
export function calculateCost(pricing: PricingSnapshot | null, tokens: CostTokens, now = new Date()): CostBreakdown | null {
  if (!pricing) return null;
  const input = Math.max(0, tokens.inputTokens);
  const cached = Math.min(input, Math.max(0, tokens.cachedInputTokens ?? 0));
  const uncached = input - cached;
  const output = Math.max(0, tokens.outputTokens);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;

  const inputCost = roundCost((uncached / 1_000_000) * pricing.inputPerMillion);
  const cachedCost = roundCost((cached / 1_000_000) * cachedRate);
  const outputCost = roundCost((output / 1_000_000) * pricing.outputPerMillion);
  return {
    input_cost: inputCost,
    cached_input_cost: cachedCost,
    output_cost: outputCost,
    total_cost: roundCost(inputCost + cachedCost + outputCost),
    currency: pricing.currency,
    pricing_version: pricing.pricingVersion,
    pricing_status: pricingStatus(pricing, now),
    pricing_verified_at: pricing.verifiedAt.toISOString(),
    calculated_at: now.toISOString(),
  };
}

export function formatUsd(value: number, fractionDigits = 4): string {
  return `$${value.toFixed(fractionDigits)}`;
}
