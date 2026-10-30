import { APIConnectionTimeoutError } from "openai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apiUsageRecords, optimisationRuns, tokenEstimates, type AppUser } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { optimisePromptForUser, type OptimiseServiceContext } from "@/lib/optimiser/service";
import { CircuitBreaker } from "@/lib/providers/circuit-breaker";
import { OpenAIOptimiserProvider } from "@/lib/providers/openai";
import { ProviderError, type OptimiseResult, type OptimiserProvider } from "@/lib/providers/types";
import { requestAccountDeletion } from "@/lib/services/deletion";
import {
  assertEstimateLinksOwned,
  compareTexts,
  estimateText,
  listModelOptions,
  listUsageRecords,
  recordApiUsage,
} from "@/lib/services/estimates";
import { addPricing, clearPricingCache, getPricingByVersion, getPricingFor } from "@/lib/services/pricing";
import { getUsageSummary, recordRun } from "@/lib/services/usage";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => clearPricingCache());

function ctx(user: AppUser, provider: OptimiserProvider, overrides: Partial<OptimiseServiceContext> = {}): OptimiseServiceContext {
  return {
    db: t.db,
    user,
    provider,
    requestId: crypto.randomUUID(),
    idempotencyKey: null,
    log: logger.withRequest("test"),
    globalDailySpendCapUsd: 0,
    maxOutputTokensCeiling: 1500,
    ...overrides,
  };
}

const validOutput = (prompt: string) =>
  JSON.stringify({
    optimised_prompt: `${prompt}\n\nKeep it under 120 words.`,
    task_category: "writing",
    change_summary: ["Added a length limit"],
    assumptions: [],
    clarification_needed: false,
    clarifying_questions: [],
    estimated_input_tokens_before: 1,
    estimated_input_tokens_after: 1,
    quality_risks: [],
  });

function fakeResponse(text: string, usage: Record<string, unknown> | undefined) {
  return {
    model: "gpt-5-mini-2025-08-07",
    status: "completed",
    incomplete_details: null,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    output_text: text,
    usage,
  };
}

/** Minimal stand-in for the SDK: each call pops the next scripted outcome. */
function fakeClient(script: Array<Error | ReturnType<typeof fakeResponse>>) {
  let n = 0;
  return {
    calls: () => n,
    responses: {
      create: () => {
        const step = script[n++];
        return {
          withResponse: async () => {
            if (!step) throw new Error("script exhausted");
            if (step instanceof Error) throw step;
            return { data: step, request_id: `req_${n}` };
          },
        };
      },
    },
  };
}

describe("pricing snapshots (§5, §8; tests 3, 8)", () => {
  it("seeds only verified rates and exposes missing pricing for the rest", async () => {
    const options = await listModelOptions(t.db, new Date("2026-10-30T12:00:00Z"));
    const byId = Object.fromEntries(options.map((o) => [o.id, o]));
    expect(byId["gpt-4o"]?.pricing).toMatchObject({ input_per_million: 2.5, cached_input_per_million: 1.25, output_per_million: 10, status: "current" });
    expect(byId["gpt-5-mini"]?.pricing?.status).toBe("current");
    expect(byId["gpt-5.4"]?.pricing).toBeNull();
  });

  it("rejects overlapping pricing periods for the same model", async () => {
    await expect(
      addPricing(t.db, {
        provider: "openai",
        modelId: "gpt-5-mini",
        pricingVersion: "openai:gpt-5-mini:overlap",
        inputPerMillion: 9,
        outputPerMillion: 9,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-02-01T00:00:00Z"),
        source: "test",
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("keeps historical snapshots reproducible after a price change", async () => {
    const before = await getPricingFor(t.db, "gpt-5-nano", new Date("2026-10-30T12:00:00Z"));
    expect(before?.inputPerMillion).toBe(0.05);
    await addPricing(
      t.db,
      {
        provider: "openai",
        modelId: "gpt-5-nano",
        pricingVersion: "openai:gpt-5-nano:2026-12-01",
        inputPerMillion: 0.04,
        cachedInputPerMillion: 0.004,
        outputPerMillion: 0.32,
        effectiveFrom: new Date("2026-12-01T00:00:00Z"),
        source: "test",
        verifiedAt: new Date("2026-12-01T00:00:00Z"),
      },
      { closePrevious: true },
    );
    expect((await getPricingFor(t.db, "gpt-5-nano", new Date("2026-11-15T00:00:00Z")))?.pricingVersion).toBe("openai:gpt-5-nano:2026-10-30");
    expect((await getPricingFor(t.db, "gpt-5-nano", new Date("2026-12-15T00:00:00Z")))?.pricingVersion).toBe("openai:gpt-5-nano:2026-12-01");
    // A stored estimate's pricing_version still resolves to the rate it used.
    expect((await getPricingByVersion(t.db, "openai:gpt-5-nano:2026-10-30"))?.outputPerMillion).toBe(0.4);

    const old = await estimateText(t.db, { text: "Write a haiku.", modelId: "gpt-5-nano", expectedOutput: 1000 }, new Date("2026-11-15T00:00:00Z"));
    const fresh = await estimateText(t.db, { text: "Write a haiku.", modelId: "gpt-5-nano", expectedOutput: 1000 }, new Date("2026-12-15T00:00:00Z"));
    expect(old.cost?.output_cost).toBeCloseTo(0.0004, 6);
    expect(fresh.cost?.output_cost).toBeCloseTo(0.00032, 6);
  });

  it("keeps sub-micro-dollar costs instead of rounding them to zero", async () => {
    const tiny = await estimateText(t.db, { text: "Write a haiku about rain.", modelId: "gpt-5-mini", expectedOutput: 0 }, new Date("2026-10-30T12:00:00Z"));
    expect(tiny.cost?.input_cost).toBeGreaterThan(0);
    expect(tiny.cost?.input_cost).toBeCloseTo((tiny.token_count * 0.25) / 1e6, 10);
  });

  it("returns counts without a cost, plus a warning, when pricing is missing", async () => {
    const result = await estimateText(t.db, { text: "Summarise this.", modelId: "gpt-5.4" });
    expect(result.token_count).toBeGreaterThan(0);
    expect(result.cost).toBeNull();
    expect(result.pricing_warning).toMatch(/No pricing/);
  });

  it("warns when pricing is older than the staleness window", async () => {
    const result = await estimateText(t.db, { text: "Hi", modelId: "gpt-4o" }, new Date("2027-06-01T00:00:00Z"));
    expect(result.cost?.pricing_status).toBe("stale");
    expect(result.pricing_warning).toMatch(/may be out of date/);
  });

  it("compares texts and prices both with the same snapshot", async () => {
    const c = await compareTexts(t.db, { original: "please kindly write me an email about the invoice", optimised: "Write an email about the invoice.", modelId: "gpt-4o", expectedOutput: "short" }, new Date("2026-10-30T12:00:00Z"));
    expect(c.cost?.input_cost_before).toBeCloseTo((c.original.token_count * 2.5) / 1e6, 10);
    expect(c.cost?.input_cost_after).toBeCloseTo((c.optimised.token_count * 2.5) / 1e6, 10);
    expect(c.cost?.output_cost).toBeCloseTo((150 * 10) / 1e6, 6);
    expect(c.cost?.input_cost_difference).toBeCloseTo(c.cost!.input_cost_before - c.cost!.input_cost_after, 6);
  });

  it("refuses unsupported models with a specific error", async () => {
    await expect(estimateText(t.db, { text: "x", modelId: "not-a-model" })).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL", status: 422 });
  });
});

describe("actual usage records (§6; tests 9, 10, 15)", () => {
  it("records each attempt once; replays cannot double-count", async () => {
    const user = await createUser(t.db, "usage-once");
    const run = await recordRun(t.db, { userId: user.id, provider: "openai", modelId: "gpt-5-mini", templateVersion: "v", taskCategory: null, status: "queued", inputChars: 1, latencyMs: 0 });
    const input = { userId: user.id, runId: run.id, attempt: 1, provider: "openai", modelId: "gpt-5-mini-2025-08-07", requestType: "prompt_optimisation", status: "ok" as const, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 };
    const first = await recordApiUsage(t.db, input);
    const second = await recordApiUsage(t.db, input);
    expect(first?.record.actualTotalTokens).toBe(1200);
    // (600 × 0.25 + 400 × 0.025 + 200 × 2.00) / 1M = (150 + 10 + 400) / 1M
    expect(Number(first?.record.actualCost)).toBeCloseTo(0.00056, 9);
    expect(first?.record.pricingVersion).toBe("openai:gpt-5-mini:2026-10-30");
    expect(second).toBeNull();
    expect(await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.runId, run.id) })).toHaveLength(1);
  });

  it("marks attempts without provider usage instead of recording zero as fact", async () => {
    const user = await createUser(t.db, "usage-unreported");
    const recorded = await recordApiUsage(t.db, { userId: user.id, runId: null, attempt: 1, provider: "openai", modelId: "gpt-5-mini", requestType: "prompt_optimisation", status: "error", inputTokens: 0, outputTokens: 0, usageReported: false });
    expect(recorded?.record.usageReported).toBe(false);
    expect(recorded?.record.actualCost).toBeNull();
  });

  it("an optimisation with a transport retry records two attempts, sums only reported usage and consumes quota once", async () => {
    const user = await createUser(t.db, "retry-user");
    const client = fakeClient([
      new APIConnectionTimeoutError(),
      fakeResponse(validOutput("write an email"), { input_tokens: 900, output_tokens: 120, total_tokens: 1020, input_tokens_details: { cached_tokens: 0 } }),
    ]);
    const provider = new OpenAIOptimiserProvider({ apiKey: "test", modelId: "gpt-5-mini", timeoutMs: 1000, client: client as never, sleep: async () => undefined, breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 }) });

    const result = await optimisePromptForUser(ctx(user, provider), { prompt: "write an email", taskCategory: "writing", options: { targetModel: "gpt-4o" } });

    expect(client.calls()).toBe(2);
    expect(result.actual_usage.attempt_count).toBe(2);
    expect(result.actual_usage.unreported_attempts).toBe(1);
    expect(result.actual_usage.total_input_tokens).toBe(900);
    expect(result.usage).toMatchObject({ input_tokens: 900, output_tokens: 120, source: "provider" });
    expect(result.estimated_cost_usd).toBeCloseTo((900 * 0.25 + 120 * 2) / 1e6, 6);

    const rows = await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.runId, result.optimisation_id) });
    expect(rows.map((r) => [r.attempt, r.status, r.usageReported])).toEqual(
      expect.arrayContaining([
        [1, "error", false],
        [2, "ok", true],
      ]),
    );
    expect(rows.find((r) => r.attempt === 2)?.providerRequestId).toBe("req_2");
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, result.optimisation_id) });
    expect(run).toMatchObject({ status: "succeeded", attemptCount: 2, inputTokens: 900, pricingVersion: "openai:gpt-5-mini:2026-10-30" });
    expect((await getUsageSummary(t.db, user)).used).toBe(1);

    // Estimates for the target model are stored separately from actual usage.
    expect(result.estimate.model).toBe("gpt-4o");
    expect(result.token_estimate.method).toBe("tokenizer:o200k_base");
    const estimates = await t.db.query.tokenEstimates.findMany({ where: eq(tokenEstimates.runId, result.optimisation_id) });
    expect(estimates.map((e) => e.label).sort()).toEqual(["optimised", "original"]);
    expect(estimates.every((e) => e.modelId === "gpt-4o" && e.pricingVersion === "openai:gpt-4o:2026-10-30")).toBe(true);
  });

  it("a malformed response followed by a repair records both billed attempts", async () => {
    const user = await createUser(t.db, "repair-user");
    const client = fakeClient([
      fakeResponse("not json", { input_tokens: 800, output_tokens: 50, total_tokens: 850 }),
      fakeResponse(validOutput("plan a launch"), { input_tokens: 800, output_tokens: 110, total_tokens: 910 }),
    ]);
    const provider = new OpenAIOptimiserProvider({ apiKey: "test", modelId: "gpt-5-mini", timeoutMs: 1000, client: client as never, sleep: async () => undefined });
    const result = await optimisePromptForUser(ctx(user, provider), { prompt: "plan a launch", taskCategory: "planning" });
    expect(result.actual_usage.attempts.map((a) => a.status)).toEqual(["invalid_output", "ok"]);
    expect(result.actual_usage.total_input_tokens).toBe(1600);
    expect(result.actual_usage.total_output_tokens).toBe(160);
  });

  it("failed operations keep the usage of attempts that were billed and consume no quota", async () => {
    const user = await createUser(t.db, "fail-user");
    const failing: OptimiserProvider = {
      name: "openai",
      modelId: "gpt-5-mini",
      async optimise() {
        throw new ProviderError("PROVIDER_UNAVAILABLE", "upstream_error", {
          attempts: [
            { attempt: 1, status: "invalid_output", modelId: "gpt-5-mini", usage: { inputTokens: 700, outputTokens: 30, totalTokens: 730, cachedInputTokens: null } },
            { attempt: 2, status: "error", modelId: "gpt-5-mini", usage: null, errorCode: "PROVIDER_UNAVAILABLE:upstream_error" },
          ],
        });
      },
    };
    await expect(optimisePromptForUser(ctx(user, failing), { prompt: "anything", taskCategory: "general" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const runs = await t.db.query.optimisationRuns.findMany({ where: eq(optimisationRuns.userId, user.id) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", attemptCount: 2, inputTokens: 700 });
    expect((await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.userId, user.id) })).length).toBe(2);
    expect((await getUsageSummary(t.db, user)).used).toBe(0);
  });

  it("an idempotent replay adds no usage records", async () => {
    const user = await createUser(t.db, "replay-user");
    const provider: OptimiserProvider = {
      name: "mock",
      modelId: "mock-optimiser",
      async optimise(): Promise<OptimiseResult> {
        return {
          kind: "ok",
          modelId: "mock-optimiser",
          attempts: [{ attempt: 1, status: "ok", modelId: "mock-optimiser", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0 } }],
          output: JSON.parse(validOutput("hi there")),
        };
      },
    };
    await optimisePromptForUser(ctx(user, provider, { idempotencyKey: "same" }), { prompt: "hi there", taskCategory: "general" });
    await optimisePromptForUser(ctx(user, provider, { idempotencyKey: "same" }), { prompt: "hi there", taskCategory: "general" });
    expect((await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.userId, user.id) })).length).toBe(1);
  });

  it("rejects an unsupported target model before calling the provider", async () => {
    const user = await createUser(t.db, "target-user");
    let called = false;
    const provider: OptimiserProvider = { name: "mock", modelId: "mock-optimiser", optimise: async () => ((called = true), Promise.reject(new Error("no"))) };
    await expect(optimisePromptForUser(ctx(user, provider), { prompt: "x", taskCategory: "general", options: { targetModel: "gpt-9" } })).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
    expect(called).toBe(false);
  });
});

describe("ownership and retention (§9; test 11)", () => {
  it("usage records and estimate links are scoped to their owner", async () => {
    const owner = await createUser(t.db, "owner-x");
    const other = await createUser(t.db, "other-x");
    const run = await recordRun(t.db, { userId: owner.id, provider: "mock", modelId: "mock-optimiser", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 1, latencyMs: 1 });
    await recordApiUsage(t.db, { userId: owner.id, runId: run.id, attempt: 1, provider: "mock", modelId: "mock-optimiser", requestType: "prompt_optimisation", status: "ok", inputTokens: 5, outputTokens: 5 });

    expect((await listUsageRecords(t.db, owner.id, 1, 25)).total).toBe(1);
    expect((await listUsageRecords(t.db, other.id, 1, 25)).total).toBe(0);
    await expect(assertEstimateLinksOwned(t.db, other.id, { runId: run.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assertEstimateLinksOwned(t.db, owner.id, { runId: run.id })).resolves.toBeUndefined();
  });

  it("account deletion removes estimates and keeps usage records as audit metadata", async () => {
    const user = await createUser(t.db, "delete-estimates");
    const result = await optimisePromptForUser(ctx(user, {
      name: "mock",
      modelId: "mock-optimiser",
      optimise: async () => ({
        kind: "ok" as const,
        modelId: "mock-optimiser",
        attempts: [{ attempt: 1, status: "ok" as const, modelId: "mock-optimiser", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 } }],
        output: JSON.parse(validOutput("bye")),
      }),
    }), { prompt: "bye", taskCategory: "general" });
    await requestAccountDeletion(t.db, user.id);
    expect(await t.db.query.tokenEstimates.findMany({ where: eq(tokenEstimates.userId, user.id) })).toHaveLength(0);
    expect(await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.runId, result.optimisation_id) })).toHaveLength(1);
  });
});
