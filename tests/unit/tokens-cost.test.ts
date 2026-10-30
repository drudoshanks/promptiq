import { describe, expect, it } from "vitest";

import { priceForModel } from "@/lib/config/models";
import { estimateCostUsd } from "@/lib/cost";
import { approximateTokens, estimateTokens } from "@/lib/tokens";

describe("token estimation (FR-002, §7.3)", () => {
  it("uses the o200k_base tokenizer and reports the method", () => {
    const result = estimateTokens("Draft an email following up on an unpaid invoice.");
    expect(result.method).toBe("tokenizer:o200k_base");
    expect(result.tokens).toBeGreaterThan(5);
    expect(result.tokens).toBeLessThan(20);
  });

  it("returns zero for empty input", () => {
    expect(estimateTokens("")).toEqual({ tokens: 0, method: "approximate" });
  });

  it("approximation stays in the same order of magnitude as the tokenizer", () => {
    const text = "Summarise the attached quarterly report for the finance team in under 200 words, keeping every figure.";
    const exact = estimateTokens(text).tokens;
    const approx = approximateTokens(text);
    expect(approx).toBeGreaterThan(exact * 0.5);
    expect(approx).toBeLessThan(exact * 2);
  });
});

describe("cost estimate (§17.1)", () => {
  it("applies input, cached and output rates per million tokens", () => {
    const { price } = priceForModel("gpt-5-mini");
    const cost = estimateCostUsd("gpt-5-mini", { inputTokens: 2_500, cachedInputTokens: 500, outputTokens: 600 });
    const expected = (2_000 / 1e6) * price.inputPerMillion + (500 / 1e6) * price.cachedInputPerMillion + (600 / 1e6) * price.outputPerMillion;
    expect(cost).toBeCloseTo(expected, 5); // stored at 6 decimal places (NUMERIC(12,6))
  });

  it("matches the SRS worked example structure (uncached input + output)", () => {
    // Typical scenario from §17.2 with gpt-5-mini list prices: 2,500 in / 600 out.
    const cost = estimateCostUsd("gpt-5-mini", { inputTokens: 2_500, outputTokens: 600 });
    expect(cost).toBeCloseTo(2_500 * 0.25 / 1e6 + 600 * 2.0 / 1e6, 9);
  });

  it("falls back to a pessimistic price for unknown models", () => {
    const { known } = priceForModel("some-future-model");
    expect(known).toBe(false);
    expect(estimateCostUsd("some-future-model", { inputTokens: 1_000, outputTokens: 100 })).toBeGreaterThan(0);
  });

  it("maps dated snapshots to their base model price", () => {
    expect(priceForModel("gpt-5-mini-2025-08-07").known).toBe(true);
  });

  it("never returns negative cost", () => {
    expect(estimateCostUsd("gpt-5-mini", { inputTokens: -5, outputTokens: -5 })).toBe(0);
  });
});
