/**
 * Token counting (FR-002, §7.3; Token & Cost Estimation Engine §3).
 *
 * Counts exactly the text supplied, with the tokenizer encoding that belongs to
 * the requested model. Unsupported models are refused — the engine never
 * silently substitutes another tokenizer. Counts exclude anything a request
 * adds around the text (message wrappers, system instructions, history, tools,
 * images), so they are labelled `text_token_estimate`; the provider's usage
 * metadata is the only source of actual usage.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

import { MAX_TOKEN_COUNT_CHARS } from "@/lib/config/estimates";
import { findSupportedModel, MODEL_MAPPING_VERSION, type Encoding } from "@/lib/config/models";

/** js-tiktoken release + encoding, recorded with every estimate for reproducibility. */
export const TOKENIZER_VERSION = `js-tiktoken@1.0.21/o200k_base/mapping-${MODEL_MAPPING_VERSION}`;

export type TokenEstimateMethod = "tokenizer:o200k_base" | "approximate";

export interface TokenEstimate {
  tokens: number;
  method: TokenEstimateMethod;
}

export type TokenCountErrorCode = "UNSUPPORTED_MODEL" | "INPUT_TOO_LARGE" | "TOKENIZER_UNAVAILABLE";

export class TokenCountError extends Error {
  constructor(
    readonly code: TokenCountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TokenCountError";
  }
}

export interface TokenCount {
  model: string;
  encoding: Encoding;
  token_count: number;
  character_count: number;
  count_type: "text_token_estimate";
  tokenizer_version: string;
}

export interface TokenComparison {
  model: string;
  encoding: Encoding;
  tokenizer_version: string;
  original: TokenCount;
  optimised: TokenCount;
  /** original − optimised; negative when the optimised prompt is longer. */
  tokens_saved: number;
  /** Percentage of the original, signed; 0 when the original is empty. */
  reduction_percent: number;
  is_smaller: boolean;
}

const encoders = new Map<Encoding, Tiktoken | null>();

function getEncoder(encoding: Encoding): Tiktoken | null {
  if (encoders.has(encoding)) return encoders.get(encoding) ?? null;
  try {
    const enc = getEncoding(encoding);
    encoders.set(encoding, enc);
    return enc;
  } catch {
    encoders.set(encoding, null);
    return null;
  }
}

/** Character count as the user perceives it (code points, so an emoji is one character). */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Count the tokens of `text` for `modelId`. Throws TokenCountError for an
 * unsupported model, oversized input or an unavailable tokenizer.
 */
export function countTokens(text: string, modelId: string): TokenCount {
  const model = findSupportedModel(modelId);
  if (!model) {
    throw new TokenCountError("UNSUPPORTED_MODEL", `Token counting is not supported for model "${modelId}".`);
  }
  if (text.length > MAX_TOKEN_COUNT_CHARS) {
    throw new TokenCountError("INPUT_TOO_LARGE", `Text exceeds the ${MAX_TOKEN_COUNT_CHARS.toLocaleString("en")} character limit for counting.`);
  }
  const enc = getEncoder(model.encoding);
  if (!enc) {
    throw new TokenCountError("TOKENIZER_UNAVAILABLE", `The ${model.encoding} tokenizer could not be loaded.`);
  }
  let tokens: number;
  try {
    tokens = text.length === 0 ? 0 : enc.encode(text, [], []).length;
  } catch (error) {
    throw new TokenCountError("TOKENIZER_UNAVAILABLE", `Tokenizer error: ${(error as Error).message}`);
  }
  return {
    model: model.id,
    encoding: model.encoding,
    token_count: tokens,
    character_count: characterCount(text),
    count_type: "text_token_estimate",
    tokenizer_version: TOKENIZER_VERSION,
  };
}

/** Count both texts with the same tokenizer and compute the difference (§4). */
export function compareTokenCounts(original: string, optimised: string, modelId: string): TokenComparison {
  const o = countTokens(original, modelId);
  const n = countTokens(optimised, modelId);
  const saved = o.token_count - n.token_count;
  return {
    model: o.model,
    encoding: o.encoding,
    tokenizer_version: o.tokenizer_version,
    original: o,
    optimised: n,
    tokens_saved: saved,
    reduction_percent: o.token_count > 0 ? Math.round((saved / o.token_count) * 1000) / 10 : 0,
    is_smaller: n.token_count < o.token_count,
  };
}

/** Cheap, dependency-free approximation used in the browser between server counts. */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  // Roughly 4 characters per token for English prose; whitespace-separated
  // chunks add a floor for code and short tokens.
  const byChars = text.length / 4;
  const byWords = text.trim().split(/\s+/).filter(Boolean).length * 1.3;
  return Math.max(1, Math.round(Math.max(byChars, byWords)));
}

/**
 * Model-agnostic estimate with the default (o200k_base) encoding, used where a
 * target model is not known (prompt_versions.token_estimate). Falls back to the
 * character heuristic only if the tokenizer cannot load, and says so.
 */
export function estimateTokens(text: string): TokenEstimate {
  if (!text) return { tokens: 0, method: "approximate" };
  const enc = getEncoder("o200k_base");
  if (enc) {
    try {
      return { tokens: enc.encode(text, [], []).length, method: "tokenizer:o200k_base" };
    } catch {
      // fall through
    }
  }
  return { tokens: approximateTokens(text), method: "approximate" };
}
