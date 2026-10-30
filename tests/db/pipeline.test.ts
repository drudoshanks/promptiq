import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/lib/api/errors";
import { PLANS } from "@/lib/config/plans";
import { appUsers, optimisationRuns, type AppUser } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { optimisePromptForUser, type OptimiseServiceContext } from "@/lib/optimiser/service";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { ProviderError, type OptimiseRequest, type OptimiseResult, type OptimiserProvider } from "@/lib/providers/types";
import { upsertPreference } from "@/lib/services/preferences";
import { getPrompt, listPrompts } from "@/lib/services/prompts";
import { getUsageSummary } from "@/lib/services/usage";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

function ctx(user: AppUser, overrides: Partial<OptimiseServiceContext> = {}): OptimiseServiceContext {
  return {
    db: t.db,
    user,
    provider: new MockOptimiserProvider(),
    requestId: crypto.randomUUID(),
    idempotencyKey: null,
    log: logger.withRequest("test"),
    globalDailySpendCapUsd: 0,
    maxOutputTokensCeiling: 1500,
    ...overrides,
  };
}

class ScriptedProvider implements OptimiserProvider {
  readonly name = "mock" as const;
  readonly modelId = "scripted";
  calls = 0;
  constructor(private readonly script: (req: OptimiseRequest) => Promise<OptimiseResult>) {}
  optimise(req: OptimiseRequest) {
    this.calls += 1;
    return this.script(req);
  }
}

describe("optimisation pipeline (§7.1, §13.2)", () => {
  it("returns a structured result, saves two versions when history is on, and consumes one quota unit", async () => {
    const user = await createUser(t.db, "pipeline-history");
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "tone", preferenceValue: { value: "professional_direct" }, source: "user_entered" });

    const result = await optimisePromptForUser(ctx(user), { prompt: "  write an email about invoice 4471 for $2,300\r\n", taskCategory: "writing" });

    expect(result.task_category).toBe("writing");
    expect(result.original_prompt).toBe("write an email about invoice 4471 for $2,300");
    expect(result.optimised_prompt).toContain("4471");
    expect(result.optimised_prompt).toContain("$2,300");
    expect(result.change_summary.length).toBeGreaterThan(0);
    expect(result.preferences_applied.effective.tone).toBe("professional_direct");
    expect(result.token_estimate.method).toBe("tokenizer:o200k_base");
    expect(result.usage.source).toBe("provider");
    expect(result.estimated_cost_usd).not.toBeNull();
    expect(result.saved_prompt_id).not.toBeNull();

    const saved = await getPrompt(t.db, user.id, result.saved_prompt_id as string);
    expect(saved.versions.map((v) => v.provenance)).toEqual(["original", "ai_optimised"]);
    expect(saved.category).toBe("writing");

    const usage = await getUsageSummary(t.db, user);
    expect(usage.used).toBe(1);
    expect(usage.remaining).toBe(PLANS.free.optimisationsPerPeriod - 1);

    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, result.optimisation_id) });
    expect(run?.status).toBe("succeeded");
    expect(run?.promptId).toBe(result.saved_prompt_id);
    expect(run?.inputTokens).toBeGreaterThan(0);
    // The run table never stores prompt text.
    expect(Object.keys(run ?? {})).not.toContain("promptText");
  });

  it("stores nothing when history is off (A-07) but still records metadata and quota", async () => {
    const user = await createUser(t.db, "pipeline-nohistory", { historyEnabled: false });
    const result = await optimisePromptForUser(ctx(user), { prompt: "summarise this report", taskCategory: "auto" });
    expect(result.saved_prompt_id).toBeNull();
    expect((await listPrompts(t.db, user.id)).total).toBe(0);
    expect((await getUsageSummary(t.db, user)).used).toBe(1);
    expect(result.task_category).toBe("summarisation"); // mock classifier
  });

  it("explicit request preferences beat saved ones and personalisation can be switched off", async () => {
    const user = await createUser(t.db, "pipeline-prefs", { personalisationEnabled: false });
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "detail", preferenceValue: { value: "detailed" }, source: "user_entered" });
    const off = await optimisePromptForUser(ctx(user), { prompt: "plan a launch", taskCategory: "planning" });
    expect(off.preferences_applied.effective.detail).toBeUndefined();

    const [on] = await t.db.update(appUsers).set({ personalisationEnabled: true }).where(eq(appUsers.id, user.id)).returning();
    const applied = await optimisePromptForUser(ctx(on as AppUser), { prompt: "plan a launch", taskCategory: "planning", preferences: { detail: "concise", bogus: "x" } });
    expect(applied.preferences_applied.effective.detail).toBe("concise");
    expect(applied.preferences_applied.sources.detail).toBe("request");
  });

  it("rejects empty and over-length prompts before calling the provider", async () => {
    const user = await createUser(t.db, "pipeline-validate");
    const provider = new ScriptedProvider(async () => {
      throw new Error("should not be called");
    });
    await expect(optimisePromptForUser(ctx(user, { provider }), { prompt: "   ", taskCategory: "auto" })).rejects.toMatchObject({ code: "PROMPT_EMPTY" });
    await expect(optimisePromptForUser(ctx(user, { provider }), { prompt: "x".repeat(PLANS.free.maxPromptChars + 1), taskCategory: "auto" })).rejects.toMatchObject({ code: "PROMPT_TOO_LONG" });
    expect(provider.calls).toBe(0);
  });

  it("enforces the plan quota server-side and records a quota signal", async () => {
    const user = await createUser(t.db, "pipeline-quota");
    const provider = new MockOptimiserProvider();
    for (let i = 0; i < PLANS.free.optimisationsPerPeriod; i++) {
      await optimisePromptForUser(ctx(user, { provider }), { prompt: `prompt number ${i}`, taskCategory: "general" });
    }
    await expect(optimisePromptForUser(ctx(user, { provider }), { prompt: "one more", taskCategory: "general" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const usage = await getUsageSummary(t.db, user);
    expect(usage.used).toBe(PLANS.free.optimisationsPerPeriod);
  });

  it("is idempotent: the same key replays the response and never bills twice", async () => {
    const user = await createUser(t.db, "pipeline-idempotent");
    const key = "client-key-1";
    const first = await optimisePromptForUser(ctx(user, { idempotencyKey: key }), { prompt: "draft a tweet", taskCategory: "writing" });
    const second = await optimisePromptForUser(ctx(user, { idempotencyKey: key }), { prompt: "draft a tweet", taskCategory: "writing" });
    expect(second.optimisation_id).toBe(first.optimisation_id);
    expect((await getUsageSummary(t.db, user)).used).toBe(1);
  });

  it("maps provider timeouts to PROVIDER_TIMEOUT, records a failed run and consumes no quota", async () => {
    const user = await createUser(t.db, "pipeline-timeout");
    const provider = new ScriptedProvider(async () => {
      throw new ProviderError("PROVIDER_TIMEOUT", "timeout");
    });
    await expect(optimisePromptForUser(ctx(user, { provider }), { prompt: "anything", taskCategory: "general" })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    const runs = await t.db.query.optimisationRuns.findMany({ where: eq(optimisationRuns.userId, user.id) });
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
    expect((await getUsageSummary(t.db, user)).used).toBe(0);
  });

  it("surfaces refusals and malformed output as safe errors without success records", async () => {
    const user = await createUser(t.db, "pipeline-refusal");
    const refusing = new ScriptedProvider(async () => ({
      kind: "refused",
      reason: "cannot help",
      modelId: "scripted",
      attempts: [{ attempt: 1, status: "refused", modelId: "scripted", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: null } }],
    }));
    await expect(optimisePromptForUser(ctx(user, { provider: refusing }), { prompt: "do something", taskCategory: "general" })).rejects.toMatchObject({ code: "OPTIMISATION_REFUSED" });

    const invalid = new ScriptedProvider(async () => ({ kind: "invalid_output", reason: "not json", modelId: "scripted", attempts: [] }));
    const error = await optimisePromptForUser(ctx(user, { provider: invalid }), { prompt: "do something", taskCategory: "general" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INVALID_MODEL_OUTPUT");

    const runs = await t.db.query.optimisationRuns.findMany({ where: eq(optimisationRuns.userId, user.id) });
    expect(runs.map((r) => r.status).sort()).toEqual(["failed", "refused"]);
    expect((await getUsageSummary(t.db, user)).used).toBe(0);
  });

  it("stops when the global daily spend cap is reached (NFR-012)", async () => {
    const user = await createUser(t.db, "pipeline-spend");
    // Seed a run with a large estimated cost so today's spend exceeds the cap.
    await t.db.insert(optimisationRuns).values({ userId: user.id, provider: "mock", modelId: "m", templateVersion: "v", status: "succeeded", inputChars: 1, estimatedCostUsd: "5.000000", latencyMs: 1 });
    await expect(optimisePromptForUser(ctx(user, { globalDailySpendCapUsd: 1 }), { prompt: "hello there", taskCategory: "general" })).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" });
  });
});
