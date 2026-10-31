import type { PlanCode } from "@/lib/db/schema";

/**
 * Plan entitlements (FR-013, §4). Enforced server-side; the UI only displays them.
 * Basic data portability (copy/TXT export) is never gated (§11.1).
 */
export interface PlanLimits {
  code: PlanCode;
  name: string;
  priceLabel: string;
  /** Optimisations per billing period. */
  optimisationsPerPeriod: number;
  /** AI prompt analyses (suggestions) per billing period. */
  analysesPerPeriod: number;
  /** Maximum prompt length in characters accepted by the optimiser. */
  maxPromptChars: number;
  /** Maximum saved prompts in the library. */
  maxSavedPrompts: number;
  /** Maximum versions kept per prompt. */
  maxVersionsPerPrompt: number;
  /** Markdown/JSON export and usage analytics. */
  advancedExport: boolean;
}

export const PLANS: Record<PlanCode, PlanLimits> = {
  free: {
    code: "free",
    name: "Free",
    priceLabel: "$0",
    optimisationsPerPeriod: 20,
    analysesPerPeriod: 30,
    maxPromptChars: 4_000,
    maxSavedPrompts: 25,
    maxVersionsPerPrompt: 10,
    advancedExport: true,
  },
  pro: {
    code: "pro",
    name: "Pro",
    priceLabel: "$12 / month",
    optimisationsPerPeriod: 500,
    analysesPerPeriod: 1000,
    maxPromptChars: 20_000,
    maxSavedPrompts: 2_000,
    maxVersionsPerPrompt: 100,
    advancedExport: true,
  },
};

export function planFor(code: PlanCode): PlanLimits {
  return PLANS[code] ?? PLANS.free;
}

/** Absolute ceiling regardless of plan, protecting the provider budget. */
export const HARD_MAX_PROMPT_CHARS = 40_000;
