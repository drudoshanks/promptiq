/**
 * Token & cost estimation settings. Shared by server and client (no secrets).
 */

/** Expected output length presets, in tokens. Assumptions, not predictions. */
export const OUTPUT_LENGTH_PRESETS = {
  short: { label: "Short", tokens: 150, hint: "a few sentences" },
  medium: { label: "Medium", tokens: 500, hint: "a few paragraphs" },
  long: { label: "Long", tokens: 1500, hint: "a long document or code" },
} as const;

export type OutputLengthPreset = keyof typeof OUTPUT_LENGTH_PRESETS;

export const DEFAULT_OUTPUT_PRESET: OutputLengthPreset = "medium";

export function isOutputPreset(value: unknown): value is OutputLengthPreset {
  return typeof value === "string" && value in OUTPUT_LENGTH_PRESETS;
}

/** Maximum text size the counting endpoints accept (characters). */
export const MAX_TOKEN_COUNT_CHARS = 120_000;

/** Maximum custom expected-output value accepted from the client (tokens). */
export const MAX_EXPECTED_OUTPUT_TOKENS = 100_000;

/** Pricing verified longer ago than this is shown as unverified, never as current. */
export const PRICING_STALE_AFTER_DAYS = 90;

/** Debounce for server-side counting while the user types (ms). */
export const COUNT_DEBOUNCE_MS = 300;
