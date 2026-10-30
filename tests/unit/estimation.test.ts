import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { describeChange, formatMoney } from "@/lib/client/estimates";
import { MAX_TOKEN_COUNT_CHARS, PRICING_STALE_AFTER_DAYS } from "@/lib/config/estimates";
import { findSupportedModel, selectableModels } from "@/lib/config/models";
import { calculateCost, pricingStatus, type PricingSnapshot } from "@/lib/cost";
import { parseResponsesUsage, sumUsage } from "@/lib/providers/usage";
import { resolveOutputLength } from "@/lib/services/estimates";
import { characterCount, compareTokenCounts, countTokens, TOKENIZER_VERSION, TokenCountError } from "@/lib/tokens";

const pricing = (overrides: Partial<PricingSnapshot> = {}): PricingSnapshot => ({
  provider: "openai",
  modelId: "gpt-5-mini",
  pricingVersion: "openai:gpt-5-mini:test",
  currency: "USD",
  inputPerMillion: 0.25,
  cachedInputPerMillion: 0.025,
  outputPerMillion: 2,
  effectiveFrom: new Date("2025-01-01T00:00:00Z"),
  effectiveTo: null,
  source: "test",
  verifiedAt: new Date("2026-10-30T00:00:00Z"),
  ...overrides,
});

describe("token counting engine (§3; tests 1–3, 14)", () => {
  it("matches OpenAI's published o200k_base fixture", () => {
    // OpenAI tiktoken cookbook: "tiktoken is great!" → [83, 8251, 2488, 382, 2212, 0].
    const result = countTokens("tiktoken is great!", "gpt-4o");
    expect(result).toMatchObject({ model: "gpt-4o", encoding: "o200k_base", token_count: 6, character_count: 18, count_type: "text_token_estimate" });
  });

  it("counts regression fixtures for code, Unicode, emoji and multilingual text", () => {
    expect(countTokens("Act as a senior engineer and review this code.", "gpt-5-mini").token_count).toBe(10);
    expect(countTokens("function f(x) { return x * 2; }\n", "gpt-5-mini").token_count).toBe(12);
    expect(countTokens("👋🌍 héllo", "gpt-5-mini").token_count).toBe(6);
    expect(countTokens("こんにちは世界", "gpt-5-mini").token_count).toBe(2);
  });

  it("counts characters as code points, so an emoji is one character", () => {
    expect(characterCount("👋🌍")).toBe(2);
    expect(countTokens("👋🌍 héllo", "gpt-5-mini").character_count).toBe(8);
  });

  it("returns zero for empty input", () => {
    expect(countTokens("", "gpt-5-mini")).toMatchObject({ token_count: 0, character_count: 0 });
  });

  it("counts special-token text literally instead of failing", () => {
    expect(countTokens("<|endoftext|>", "gpt-5-mini").token_count).toBe(7);
  });

  it("refuses unsupported models instead of substituting a tokenizer", () => {
    expect(() => countTokens("hello", "claude-opus")).toThrow(TokenCountError);
    try {
      countTokens("hello", "gpt-9");
    } catch (error) {
      expect((error as TokenCountError).code).toBe("UNSUPPORTED_MODEL");
    }
  });

  it("maps dated snapshots to their base model and nothing else", () => {
    expect(findSupportedModel("gpt-5-mini-2025-08-07")?.id).toBe("gpt-5-mini");
    expect(findSupportedModel("gpt-5-minix")).toBeNull();
    expect(selectableModels().some((m) => m.id === "mock-optimiser")).toBe(false);
  });

  it("rejects oversized input", () => {
    expect(() => countTokens("a".repeat(MAX_TOKEN_COUNT_CHARS + 1), "gpt-5-mini")).toThrow(/character limit/);
  });

  it("records the installed tokenizer version for reproducibility", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("node_modules/js-tiktoken/package.json"), "utf8")) as { version: string };
    expect(TOKENIZER_VERSION).toContain(`js-tiktoken@${pkg.version}`);
  });
});

describe("original vs optimised comparison (§4; tests 4–6)", () => {
  it("computes savings with one tokenizer", () => {
    const c = compareTokenCounts("please could you kindly write me a very short email", "Write a short email.", "gpt-5-mini");
    expect(c.tokens_saved).toBe(c.original.token_count - c.optimised.token_count);
    expect(c.tokens_saved).toBeGreaterThan(0);
    expect(c.is_smaller).toBe(true);
    expect(c.reduction_percent).toBeCloseTo((c.tokens_saved / c.original.token_count) * 100, 1);
  });

  it("reports a negative saving when the optimised prompt is longer", () => {
    const c = compareTokenCounts("Write an email.", "Write a short, polite email to the client about invoice 4471, due 12 Sept.", "gpt-5-mini");
    expect(c.tokens_saved).toBeLessThan(0);
    expect(c.reduction_percent).toBeLessThan(0);
    expect(c.is_smaller).toBe(false);
    expect(describeChange(c.tokens_saved, c.reduction_percent)).toMatch(/more \(.*% larger\)/);
  });

  it("does not divide by zero when the original is empty", () => {
    const c = compareTokenCounts("", "Write a haiku.", "gpt-5-mini");
    expect(c.reduction_percent).toBe(0);
    expect(Number.isFinite(c.reduction_percent)).toBe(true);
  });

  it("describes no change explicitly", () => {
    expect(describeChange(0, 0)).toBe("No change");
    expect(describeChange(12, 25)).toBe("12 fewer (25% smaller)");
  });
});

describe("cost calculator (§5; tests 3, 7)", () => {
  it("prices input and output separately per million tokens", () => {
    const cost = calculateCost(pricing(), { inputTokens: 2_500, outputTokens: 600 }, new Date("2026-10-30T12:00:00Z"));
    expect(cost).toMatchObject({ input_cost: 0.000625, output_cost: 0.0012, total_cost: 0.001825, currency: "USD", pricing_version: "openai:gpt-5-mini:test" });
  });

  it("prices cached input at the cached rate", () => {
    const cost = calculateCost(pricing(), { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 });
    expect(cost?.input_cost).toBeCloseTo(0.15, 6); // 600k × $0.25
    expect(cost?.cached_input_cost).toBeCloseTo(0.01, 6); // 400k × $0.025
  });

  it("returns no cost, rather than an invented one, when pricing is missing", () => {
    expect(calculateCost(null, { inputTokens: 100, outputTokens: 100 })).toBeNull();
    expect(pricingStatus(null)).toBe("missing");
  });

  it("flags stale pricing", () => {
    const verifiedAt = new Date("2026-01-01T00:00:00Z");
    const later = new Date(verifiedAt.getTime() + (PRICING_STALE_AFTER_DAYS + 1) * 86_400_000);
    expect(pricingStatus(pricing({ verifiedAt }), later)).toBe("stale");
    expect(pricingStatus(pricing({ verifiedAt }), verifiedAt)).toBe("current");
  });

  it("clamps negative token counts", () => {
    expect(calculateCost(pricing(), { inputTokens: -10, outputTokens: -10 })?.total_cost).toBe(0);
  });

  it("resolves output length presets and custom values as assumptions", () => {
    expect(resolveOutputLength("short")).toEqual({ tokens: 150, preset: "short" });
    expect(resolveOutputLength(undefined).preset).toBe("medium");
    expect(resolveOutputLength(42.4)).toEqual({ tokens: 42, preset: "custom" });
  });

  it("formats sub-cent amounts with enough precision", () => {
    expect(formatMoney(0.000625)).toBe("$0.000625");
    expect(formatMoney(0.00000035)).toBe("$0.00000035");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-0.5)).toBe("−$0.5000");
  });
});

describe("provider usage parsing (§6; test 9)", () => {
  it("reads Responses API usage including cached tokens", () => {
    expect(parseResponsesUsage({ input_tokens: 812, output_tokens: 140, total_tokens: 952, input_tokens_details: { cached_tokens: 640 }, output_tokens_details: { reasoning_tokens: 64 } })).toEqual({
      inputTokens: 812,
      outputTokens: 140,
      totalTokens: 952,
      cachedInputTokens: 640,
    });
  });

  it("returns null when usage is absent or malformed, never a guess", () => {
    expect(parseResponsesUsage(undefined)).toBeNull();
    expect(parseResponsesUsage({ input_tokens: "12" })).toBeNull();
    expect(parseResponsesUsage({ input_tokens: -1, output_tokens: 3 })).toBeNull();
  });

  it("derives total when missing and caps cached at input", () => {
    expect(parseResponsesUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 99 } })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 10 });
  });

  it("sums attempts and ignores those without usage", () => {
    const total = sumUsage([null, { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: null }, { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedInputTokens: 4 }]);
    expect(total).toEqual({ inputTokens: 15, outputTokens: 3, totalTokens: 18, cachedInputTokens: 4 });
    expect(sumUsage([null, null])).toBeNull();
  });
});
