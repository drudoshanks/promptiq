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
  /** No monthly quotas or library caps (free mode). */
  unlimited: boolean;
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
    unlimited: false,
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
    unlimited: false,
  },
};

/** Absolute ceiling regardless of plan, protecting the provider budget. */
export const HARD_MAX_PROMPT_CHARS = 40_000;

/** Stands in for "no limit" where a number is required (quota checks, version pruning). */
export const UNLIMITED = 1_000_000_000;

/**
 * Free mode: PromptIQ is 100% free for everyone. No monthly quotas, no library
 * caps, no per-user rate limits and no paid plans on sale. On by default; set
 * FREE_MODE=false to bring plans, quotas and payments back unchanged.
 * Read straight from process.env so this module stays importable anywhere.
 */
export function isFreeMode(): boolean {
  return (process.env.FREE_MODE ?? "true").trim().toLowerCase() !== "false";
}

export const FREE_FOR_ALL: PlanLimits = {
  code: "free",
  name: "Free",
  priceLabel: "Free",
  optimisationsPerPeriod: UNLIMITED,
  analysesPerPeriod: UNLIMITED,
  maxPromptChars: HARD_MAX_PROMPT_CHARS,
  maxSavedPrompts: UNLIMITED,
  maxVersionsPerPrompt: UNLIMITED,
  advancedExport: true,
  unlimited: true,
};

export function planFor(code: PlanCode): PlanLimits {
  if (isFreeMode()) return { ...FREE_FOR_ALL, code: code in PLANS ? code : "free" };
  return PLANS[code] ?? PLANS.free;
}
