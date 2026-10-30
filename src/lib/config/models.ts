/**
 * Supported model registry: the allowlist of models PromptIQ can count tokens
 * for, and which tokenizer encoding each one uses. Prices are NOT here — they
 * live in the versioned `model_pricing` table (migration 0003) so they can be
 * updated and audited without a deploy.
 *
 * Mapping source: OpenAI tokenizer documentation. GPT-4o, GPT-4.1 and the GPT-5
 * families share the o200k_base encoding. A model that is not listed here is
 * "unsupported": counting is refused rather than silently using another
 * tokenizer. Last reviewed: 2026-10-30.
 */
export type Encoding = "o200k_base";

export interface SupportedModel {
  id: string;
  provider: "openai" | "mock";
  label: string;
  encoding: Encoding;
  /** Whether the model accepts the Responses API `reasoning.effort` parameter. */
  reasoning: boolean;
  /** Shown in the target-model selector; the mock model is internal. */
  selectable: boolean;
}

export const MODEL_MAPPING_VERSION = "2026-10-30";

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { id: "gpt-5", provider: "openai", label: "GPT-5", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-5-nano", provider: "openai", label: "GPT-5 nano", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-5.4-mini", provider: "openai", label: "GPT-5.4 mini", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-5.4-nano", provider: "openai", label: "GPT-5.4 nano", encoding: "o200k_base", reasoning: true, selectable: true },
  { id: "gpt-4.1", provider: "openai", label: "GPT-4.1", encoding: "o200k_base", reasoning: false, selectable: true },
  { id: "gpt-4.1-mini", provider: "openai", label: "GPT-4.1 mini", encoding: "o200k_base", reasoning: false, selectable: true },
  { id: "gpt-4.1-nano", provider: "openai", label: "GPT-4.1 nano", encoding: "o200k_base", reasoning: false, selectable: true },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", encoding: "o200k_base", reasoning: false, selectable: true },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini", encoding: "o200k_base", reasoning: false, selectable: true },
  { id: "mock-optimiser", provider: "mock", label: "Mock optimiser (development)", encoding: "o200k_base", reasoning: false, selectable: false },
];

/** Default target model for estimates when the user has not chosen one. */
export const DEFAULT_TARGET_MODEL = "gpt-5-mini";

/**
 * Resolve a model id to its registry entry. Dated snapshots such as
 * `gpt-5-mini-2025-08-07` map to their base model; anything else is unsupported.
 */
export function findSupportedModel(modelId: string): SupportedModel | null {
  const exact = SUPPORTED_MODELS.find((m) => m.id === modelId);
  if (exact) return exact;
  const snapshot = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(modelId);
  if (snapshot?.[1]) {
    const base = SUPPORTED_MODELS.find((m) => m.id === snapshot[1]);
    if (base) return base;
  }
  return null;
}

export function isSupportedModel(modelId: string): boolean {
  return findSupportedModel(modelId) !== null;
}

export function selectableModels(): SupportedModel[] {
  return SUPPORTED_MODELS.filter((m) => m.selectable);
}
