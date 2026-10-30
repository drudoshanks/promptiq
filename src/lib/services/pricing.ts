import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";

import { findSupportedModel } from "@/lib/config/models";
import { type PricingSnapshot } from "@/lib/cost";
import { modelPricing, type ModelPricing } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

/**
 * Pricing snapshots (§5). The database is the source of truth; application code
 * never hardcodes a rate. Lookups are cached in-process for a minute so that
 * debounced counting while typing does not hit the database on every call.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: PricingSnapshot | null }>();

export function toSnapshot(row: ModelPricing): PricingSnapshot {
  return {
    provider: row.provider,
    modelId: row.modelId,
    pricingVersion: row.pricingVersion,
    currency: row.currency,
    inputPerMillion: Number(row.inputPerMillion),
    cachedInputPerMillion: row.cachedInputPerMillion === null ? null : Number(row.cachedInputPerMillion),
    outputPerMillion: Number(row.outputPerMillion),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * The pricing record in force for `modelId` at `at` (default: now). Dated model
 * snapshots (gpt-5-mini-2025-08-07) resolve to their base model's pricing. A
 * missing record returns null — callers must then show "pricing unavailable".
 */
export async function getPricingFor(db: DbOrTx, modelId: string, at = new Date()): Promise<PricingSnapshot | null> {
  const model = findSupportedModel(modelId);
  const lookupId = model?.id ?? modelId;
  const isNow = Math.abs(Date.now() - at.getTime()) < 1_000;
  const key = `${lookupId}`;
  if (isNow) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const row = await db.query.modelPricing.findFirst({
    where: and(
      eq(modelPricing.modelId, lookupId),
      lte(modelPricing.effectiveFrom, at),
      or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, at)),
    ),
    orderBy: [desc(modelPricing.effectiveFrom)],
  });
  const value = row ? toSnapshot(row) : null;
  if (isNow) cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

/** Find a snapshot by its version label (for reproducing a stored estimate). */
export async function getPricingByVersion(db: DbOrTx, pricingVersion: string): Promise<PricingSnapshot | null> {
  const row = await db.query.modelPricing.findFirst({ where: eq(modelPricing.pricingVersion, pricingVersion) });
  return row ? toSnapshot(row) : null;
}

/** Every record currently in force, keyed by model id. */
export async function listCurrentPricing(db: DbOrTx, at = new Date()): Promise<Map<string, PricingSnapshot>> {
  const rows = await db.query.modelPricing.findMany({
    where: and(lte(modelPricing.effectiveFrom, at), or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, at))),
    orderBy: [desc(modelPricing.effectiveFrom)],
  });
  const map = new Map<string, PricingSnapshot>();
  for (const row of rows) if (!map.has(row.modelId)) map.set(row.modelId, toSnapshot(row));
  return map;
}

export interface NewPricingInput {
  provider: string;
  modelId: string;
  pricingVersion: string;
  currency?: string;
  inputPerMillion: number;
  cachedInputPerMillion?: number | null;
  outputPerMillion: number;
  extraPrices?: Record<string, number>;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  source: string;
  verifiedAt: Date;
  notes?: string | null;
}

/**
 * Record a new pricing snapshot. When `closePrevious` is set, the currently
 * open record for the model is ended at the new record's effective_from so the
 * database overlap guard accepts the change (the operator's usual path).
 */
export async function addPricing(db: DbOrTx, input: NewPricingInput, options: { closePrevious?: boolean } = {}): Promise<ModelPricing> {
  if (options.closePrevious) {
    await db
      .update(modelPricing)
      .set({ effectiveTo: input.effectiveFrom })
      .where(and(eq(modelPricing.provider, input.provider), eq(modelPricing.modelId, input.modelId), isNull(modelPricing.effectiveTo)));
  }
  const [row] = await db
    .insert(modelPricing)
    .values({
      provider: input.provider,
      modelId: input.modelId,
      pricingVersion: input.pricingVersion,
      currency: input.currency ?? "USD",
      inputPerMillion: input.inputPerMillion.toFixed(6),
      cachedInputPerMillion: input.cachedInputPerMillion === null || input.cachedInputPerMillion === undefined ? null : input.cachedInputPerMillion.toFixed(6),
      outputPerMillion: input.outputPerMillion.toFixed(6),
      extraPrices: input.extraPrices ?? {},
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      source: input.source,
      verifiedAt: input.verifiedAt,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to add pricing");
  cache.clear();
  return row;
}

/** Test helper. */
export function clearPricingCache(): void {
  cache.clear();
}
