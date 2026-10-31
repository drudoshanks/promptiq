import { and, asc, count, desc, eq } from "drizzle-orm";

import { AppError } from "@/lib/api/errors";
import { DEFAULT_OUTPUT_PRESET, OUTPUT_LENGTH_PRESETS, type OutputLengthPreset } from "@/lib/config/estimates";
import { findSupportedModel, selectableModels } from "@/lib/config/models";
import { calculateCost, pricingStatus, roundCost, type CostBreakdown, type PricingSnapshot, type PricingStatus } from "@/lib/cost";
import {
  apiUsageRecords,
  optimisationRuns,
  prompts,
  promptVersions,
  tokenEstimates,
  type ApiUsageRecord,
  type EstimateLabel,
  type TokenEstimate,
  type UsageRecordStatus,
} from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";
import { compareTokenCounts, countTokens, TokenCountError, type TokenComparison, type TokenCount } from "@/lib/tokens";

import { getPricingFor, listCurrentPricing } from "./pricing";
import { notFound } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// Estimates (text PromptIQ counted) — §3, §4, §5
// ---------------------------------------------------------------------------
export interface EstimateCost {
  expected_output_tokens: number;
  expected_output_preset: OutputLengthPreset | "custom";
  input_cost: number;
  output_cost: number;
  total_cost: number;
  currency: string;
  pricing_version: string;
  pricing_status: PricingStatus;
  pricing_verified_at: string;
  calculated_at: string;
}

export interface TokenEstimateResult extends TokenCount {
  /** Null when no pricing snapshot is in force for the model. */
  cost: EstimateCost | null;
  pricing_warning: string | null;
  limitations: string;
}

export interface TokenComparisonResult extends TokenComparison {
  cost: {
    expected_output_tokens: number;
    expected_output_preset: OutputLengthPreset | "custom";
    input_cost_before: number;
    input_cost_after: number;
    input_cost_difference: number;
    output_cost: number;
    total_cost_before: number;
    total_cost_after: number;
    currency: string;
    pricing_version: string;
    pricing_status: PricingStatus;
    pricing_verified_at: string;
    calculated_at: string;
  } | null;
  pricing_warning: string | null;
  limitations: string;
}

export const COUNT_LIMITATIONS =
  "Counts cover only the text shown, with the tokenizer for the selected model. Message wrappers, system instructions, conversation history, tools and attachments add tokens the model will also bill. Output length is an assumption. Estimates are not a prediction of answer quality or of your total spend.";

export interface OutputLength {
  tokens: number;
  preset: OutputLengthPreset | "custom";
}

export function resolveOutputLength(value: OutputLengthPreset | number | undefined): OutputLength {
  if (typeof value === "number") return { tokens: Math.max(0, Math.round(value)), preset: "custom" };
  const preset = value ?? DEFAULT_OUTPUT_PRESET;
  return { tokens: OUTPUT_LENGTH_PRESETS[preset].tokens, preset };
}

export function pricingWarning(pricing: PricingSnapshot | null, modelId: string, now = new Date()): string | null {
  const status = pricingStatus(pricing, now);
  if (status === "missing") return `No pricing is configured for ${modelId}; token counts are shown without a cost.`;
  if (status === "stale") {
    return `Pricing for ${modelId} was last verified on ${pricing!.verifiedAt.toISOString().slice(0, 10)} and may be out of date.`;
  }
  return null;
}

/** Map tokenizer errors to API errors with the right status. */
export function toApiError(error: unknown): never {
  if (error instanceof TokenCountError) {
    if (error.code === "INPUT_TOO_LARGE") throw new AppError("PROMPT_TOO_LONG", error.message);
    if (error.code === "UNSUPPORTED_MODEL") throw new AppError("UNSUPPORTED_MODEL", error.message);
    throw new AppError("INTERNAL_ERROR", error.message);
  }
  throw error;
}

function estimateCost(pricing: PricingSnapshot | null, inputTokens: number, output: OutputLength, now: Date): EstimateCost | null {
  const breakdown = calculateCost(pricing, { inputTokens, outputTokens: output.tokens }, now);
  if (!breakdown) return null;
  return {
    expected_output_tokens: output.tokens,
    expected_output_preset: output.preset,
    input_cost: breakdown.input_cost,
    output_cost: breakdown.output_cost,
    total_cost: breakdown.total_cost,
    currency: breakdown.currency,
    pricing_version: breakdown.pricing_version,
    pricing_status: breakdown.pricing_status,
    pricing_verified_at: breakdown.pricing_verified_at,
    calculated_at: breakdown.calculated_at,
  };
}

/** Count one text and price it for the target model. Pure apart from the pricing lookup. */
export async function estimateText(
  db: DbOrTx,
  input: { text: string; modelId: string; expectedOutput?: OutputLengthPreset | number },
  now = new Date(),
): Promise<TokenEstimateResult> {
  let count: TokenCount;
  try {
    count = countTokens(input.text, input.modelId);
  } catch (error) {
    toApiError(error);
  }
  const pricing = await getPricingFor(db, count.model, now);
  const output = resolveOutputLength(input.expectedOutput);
  return {
    ...count,
    cost: estimateCost(pricing, count.token_count, output, now),
    pricing_warning: pricingWarning(pricing, count.model, now),
    limitations: COUNT_LIMITATIONS,
  };
}

/** Count original and optimised text with the same tokenizer and price both (§4). */
export async function compareTexts(
  db: DbOrTx,
  input: { original: string; optimised: string; modelId: string; expectedOutput?: OutputLengthPreset | number },
  now = new Date(),
): Promise<TokenComparisonResult> {
  let comparison: TokenComparison;
  try {
    comparison = compareTokenCounts(input.original, input.optimised, input.modelId);
  } catch (error) {
    toApiError(error);
  }
  const pricing = await getPricingFor(db, comparison.model, now);
  const output = resolveOutputLength(input.expectedOutput);
  const before = calculateCost(pricing, { inputTokens: comparison.original.token_count, outputTokens: output.tokens }, now);
  const after = calculateCost(pricing, { inputTokens: comparison.optimised.token_count, outputTokens: output.tokens }, now);
  const cost: TokenComparisonResult["cost"] =
    before && after
      ? {
          expected_output_tokens: output.tokens,
          expected_output_preset: output.preset,
          input_cost_before: before.input_cost,
          input_cost_after: after.input_cost,
          input_cost_difference: roundCost(before.input_cost - after.input_cost),
          output_cost: after.output_cost,
          total_cost_before: before.total_cost,
          total_cost_after: after.total_cost,
          currency: after.currency,
          pricing_version: after.pricing_version,
          pricing_status: after.pricing_status,
          pricing_verified_at: after.pricing_verified_at,
          calculated_at: after.calculated_at,
        }
      : null;
  return { ...comparison, cost, pricing_warning: pricingWarning(pricing, comparison.model, now), limitations: COUNT_LIMITATIONS };
}

// ---------------------------------------------------------------------------
// Persistence — only at meaningful moments (optimisation complete, export),
// never per keystroke (§9).
// ---------------------------------------------------------------------------
export interface RecordEstimateInput {
  userId: string;
  label: EstimateLabel;
  estimate: TokenEstimateResult;
  promptVersionId?: string | null;
  runId?: string | null;
}

export async function recordTokenEstimate(db: DbOrTx, input: RecordEstimateInput): Promise<TokenEstimate> {
  const { estimate } = input;
  const [row] = await db
    .insert(tokenEstimates)
    .values({
      userId: input.userId,
      promptVersionId: input.promptVersionId ?? null,
      runId: input.runId ?? null,
      label: input.label,
      modelId: estimate.model,
      encoding: estimate.encoding,
      tokenizerVersion: estimate.tokenizer_version,
      inputTokens: estimate.token_count,
      characterCount: estimate.character_count,
      expectedOutputTokens: estimate.cost?.expected_output_tokens ?? resolveOutputLength(undefined).tokens,
      estimatedInputCost: estimate.cost ? estimate.cost.input_cost.toFixed(10) : null,
      estimatedOutputCost: estimate.cost ? estimate.cost.output_cost.toFixed(10) : null,
      estimatedTotalCost: estimate.cost ? estimate.cost.total_cost.toFixed(10) : null,
      pricingVersion: estimate.cost?.pricing_version ?? null,
      currency: estimate.cost?.currency ?? "USD",
    })
    .returning();
  if (!row) throw new Error("Failed to record token estimate");
  return row;
}

export async function listEstimatesForRun(db: DbOrTx, userId: string, runId: string): Promise<TokenEstimate[]> {
  return db.query.tokenEstimates.findMany({
    where: and(eq(tokenEstimates.userId, userId), eq(tokenEstimates.runId, runId)),
    orderBy: [asc(tokenEstimates.createdAt)],
  });
}

export function serialiseTokenEstimate(row: TokenEstimate) {
  return {
    id: row.id,
    label: row.label,
    prompt_version_id: row.promptVersionId,
    run_id: row.runId,
    model: row.modelId,
    encoding: row.encoding,
    tokenizer_version: row.tokenizerVersion,
    token_count: row.inputTokens,
    character_count: row.characterCount,
    expected_output_tokens: row.expectedOutputTokens,
    estimated_input_cost: row.estimatedInputCost === null ? null : Number(row.estimatedInputCost),
    estimated_output_cost: row.estimatedOutputCost === null ? null : Number(row.estimatedOutputCost),
    estimated_total_cost: row.estimatedTotalCost === null ? null : Number(row.estimatedTotalCost),
    pricing_version: row.pricingVersion,
    currency: row.currency,
    count_type: "text_token_estimate" as const,
    created_at: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Actual usage (what the provider reported) — §6
// ---------------------------------------------------------------------------
export interface RecordUsageInput {
  userId: string;
  runId: string | null;
  /** Set instead of runId for prompt analyses. */
  analysisId?: string | null;
  attempt: number;
  provider: string;
  modelId: string;
  requestType: string;
  providerRequestId?: string | null;
  status: UsageRecordStatus;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | null;
  /** False when the provider returned no usage for this attempt. */
  usageReported?: boolean;
}

export interface RecordedUsage {
  record: ApiUsageRecord;
  cost: CostBreakdown | null;
}

/**
 * Record one provider attempt. Cost uses the pricing snapshot in force for the
 * model that served the attempt. (run_id, attempt) is unique, so a replayed
 * write cannot double-count.
 */
export async function recordApiUsage(db: DbOrTx, input: RecordUsageInput, now = new Date()): Promise<RecordedUsage | null> {
  const reported = input.usageReported ?? true;
  const model = findSupportedModel(input.modelId);
  const pricing = await getPricingFor(db, model?.id ?? input.modelId, now);
  const cost = reported
    ? calculateCost(pricing, { inputTokens: input.inputTokens, cachedInputTokens: input.cachedInputTokens ?? 0, outputTokens: input.outputTokens }, now)
    : null;
  const inserted = await db
    .insert(apiUsageRecords)
    .values({
      userId: input.userId,
      runId: input.runId,
      analysisId: input.analysisId ?? null,
      attempt: input.attempt,
      provider: input.provider,
      modelId: input.modelId,
      requestType: input.requestType,
      providerRequestId: input.providerRequestId ?? null,
      status: input.status,
      usageReported: reported,
      actualInputTokens: reported ? Math.max(0, input.inputTokens) : 0,
      actualOutputTokens: reported ? Math.max(0, input.outputTokens) : 0,
      actualTotalTokens: reported ? Math.max(0, input.inputTokens) + Math.max(0, input.outputTokens) : 0,
      cachedInputTokens: reported ? (input.cachedInputTokens ?? null) : null,
      actualCost: cost ? cost.total_cost.toFixed(10) : null,
      pricingVersion: cost?.pricing_version ?? pricing?.pricingVersion ?? null,
      currency: cost?.currency ?? "USD",
    })
    .onConflictDoNothing()
    .returning();
  const record = inserted[0];
  return record ? { record, cost } : null;
}

export async function listUsageForRun(db: DbOrTx, userId: string, runId: string): Promise<ApiUsageRecord[]> {
  return db.query.apiUsageRecords.findMany({
    where: and(eq(apiUsageRecords.userId, userId), eq(apiUsageRecords.runId, runId)),
    orderBy: [asc(apiUsageRecords.attempt)],
  });
}

export function serialiseUsageRecord(row: ApiUsageRecord) {
  return {
    id: row.id,
    run_id: row.runId,
    attempt: row.attempt,
    provider: row.provider,
    model: row.modelId,
    request_type: row.requestType,
    provider_request_id: row.providerRequestId,
    status: row.status,
    usage_reported: row.usageReported,
    actual_input_tokens: row.actualInputTokens,
    actual_output_tokens: row.actualOutputTokens,
    actual_total_tokens: row.actualTotalTokens,
    cached_input_tokens: row.cachedInputTokens,
    actual_cost: row.actualCost === null ? null : Number(row.actualCost),
    pricing_version: row.pricingVersion,
    currency: row.currency,
    usage_source: "provider" as const,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Aggregate the attempts of one logical operation. Tokens and cost cover the
 * attempts the provider reported usage for; `unreported_attempts` counts the
 * rest (e.g. timeouts) so totals are never presented as more complete than they are.
 * `actual_cost` is null when a reported attempt could not be priced.
 */
export function summariseUsage(rows: ApiUsageRecord[]) {
  const reported = rows.filter((r) => r.usageReported);
  const priced = reported.length > 0 && reported.every((r) => r.actualCost !== null);
  const sum = (pick: (r: ApiUsageRecord) => number) => reported.reduce((n, r) => n + pick(r), 0);
  return {
    attempts: rows.map(serialiseUsageRecord),
    attempt_count: rows.length,
    unreported_attempts: rows.length - reported.length,
    total_input_tokens: sum((r) => r.actualInputTokens),
    total_output_tokens: sum((r) => r.actualOutputTokens),
    total_tokens: sum((r) => r.actualTotalTokens),
    total_cached_input_tokens: sum((r) => r.cachedInputTokens ?? 0),
    actual_cost: priced ? roundCost(sum((r) => Number(r.actualCost))) : null,
    currency: rows[0]?.currency ?? "USD",
    pricing_version: reported.find((r) => r.pricingVersion)?.pricingVersion ?? null,
    usage_source: "provider" as const,
  };
}

// ---------------------------------------------------------------------------
// Queries for the API
// ---------------------------------------------------------------------------

/**
 * Before linking a stored estimate to a run or prompt version, prove the caller
 * owns them (an unowned ID behaves exactly like a missing one).
 */
export async function assertEstimateLinksOwned(db: DbOrTx, userId: string, links: { runId?: string | null; promptVersionId?: string | null }): Promise<void> {
  if (links.runId) {
    const run = await db.query.optimisationRuns.findFirst({
      where: and(eq(optimisationRuns.id, links.runId), eq(optimisationRuns.userId, userId)),
      columns: { id: true },
    });
    if (!run) throw notFound("Optimisation");
  }
  if (links.promptVersionId) {
    const rows = await db
      .select({ id: promptVersions.id })
      .from(promptVersions)
      .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
      .where(and(eq(promptVersions.id, links.promptVersionId), eq(prompts.userId, userId)))
      .limit(1);
    if (rows.length === 0) throw notFound("Prompt version");
  }
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  encoding: string;
  pricing: {
    status: PricingStatus;
    pricing_version: string;
    currency: string;
    input_per_million: number;
    cached_input_per_million: number | null;
    output_per_million: number;
    effective_from: string;
    verified_at: string;
    source: string;
  } | null;
}

/** Selectable target models with their current pricing snapshot (or null). */
export async function listModelOptions(db: DbOrTx, now = new Date()): Promise<ModelOption[]> {
  const pricing = await listCurrentPricing(db, now);
  return selectableModels().map((m) => {
    const p = pricing.get(m.id) ?? null;
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      encoding: m.encoding,
      pricing: p
        ? {
            status: pricingStatus(p, now),
            pricing_version: p.pricingVersion,
            currency: p.currency,
            input_per_million: p.inputPerMillion,
            cached_input_per_million: p.cachedInputPerMillion,
            output_per_million: p.outputPerMillion,
            effective_from: p.effectiveFrom.toISOString(),
            verified_at: p.verifiedAt.toISOString(),
            source: p.source,
          }
        : null,
    };
  });
}

/** The caller's actual API usage records, newest first. */
export async function listUsageRecords(db: DbOrTx, userId: string, page: number, pageSize: number) {
  const where = eq(apiUsageRecords.userId, userId);
  const [rows, totalRows] = await Promise.all([
    db.query.apiUsageRecords.findMany({
      where,
      orderBy: [desc(apiUsageRecords.createdAt), desc(apiUsageRecords.attempt)],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    db.select({ total: count() }).from(apiUsageRecords).where(where),
  ]);
  return { items: rows.map(serialiseUsageRecord), total: Number(totalRows[0]?.total ?? 0), page, page_size: pageSize };
}
