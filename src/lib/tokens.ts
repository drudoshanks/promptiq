/**
 * Token estimation (FR-002, §7.3). Uses the o200k_base tokenizer (the encoding of
 * the GPT-4o / GPT-5 families) when available and falls back to a character
 * heuristic. The method is always reported so the UI can label the number as an
 * estimate (§11.1). Actual API usage metadata, when present, is authoritative for
 * the call that produced it — not for future executions of the exported prompt.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

export type TokenEstimateMethod = "tokenizer:o200k_base" | "approximate";

export interface TokenEstimate {
  tokens: number;
  method: TokenEstimateMethod;
}

let encoder: Tiktoken | null | undefined;

function getEncoder(): Tiktoken | null {
  if (encoder !== undefined) return encoder;
  try {
    encoder = getEncoding("o200k_base");
  } catch {
    encoder = null;
  }
  return encoder;
}

/** Cheap, dependency-free approximation used in the browser and as a fallback. */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  // Roughly 4 characters per token for English prose; whitespace-separated
  // chunks add a floor for code and short tokens.
  const byChars = text.length / 4;
  const byWords = text.trim().split(/\s+/).filter(Boolean).length * 1.3;
  return Math.max(1, Math.round(Math.max(byChars, byWords)));
}

export function estimateTokens(text: string): TokenEstimate {
  if (!text) return { tokens: 0, method: "approximate" };
  const enc = getEncoder();
  if (enc) {
    try {
      return { tokens: enc.encode(text).length, method: "tokenizer:o200k_base" };
    } catch {
      // fall through
    }
  }
  return { tokens: approximateTokens(text), method: "approximate" };
}
