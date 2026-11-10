import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLANS } from "@/lib/config/plans";
import { apiUsageRecords, usageEvents, type AppUser } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import type { AiProvider, BreakdownRequest } from "@/lib/providers/types";
import { breakdownForUser, saveBreakdownSteps } from "@/lib/services/breakdown";
import type { IntelligenceContext } from "@/lib/services/intelligence";
import { createPrompt, getPrompt, listPrompts } from "@/lib/services/prompts";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;
const mock = new MockOptimiserProvider();
const ctx = (user: AppUser, provider: AiProvider = mock): IntelligenceContext => ({ db: t.db, user, provider, requestId: crypto.randomUUID(), log: logger.withRequest("t"), globalDailySpendCapUsd: 0 });
const BIG = `We are a two-person design studio in Bengaluru.
Write a case study about our café rebrand, then create a LinkedIn post promoting the case study, and draft a cold email to restaurant owners that links to it.
Keep a confident but humble tone. Don't name the client.`;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("breakdown", () => {
  it("returns steps, advice and coverage for unsaved text, records usage, and is free with the rule-based engine", async () => {
    const user = await createUser(t.db, "bd-adhoc");
    const r = await breakdownForUser(ctx(user), { source: { text: BIG } });
    expect(r.engine).toBe("rules");
    expect(r.assessment.level).toBe("recommended");
    expect(r.steps.map((s) => s.title)).toEqual(["Write a case study", "Create a LinkedIn post", "Draft a cold email", "Check everything against your requirements"]);
    expect(r.steps[1]).toMatchObject({ depends_on: [1], parallel_with: [3] });
    expect(r.steps.every((s) => s.tokens > 0)).toBe(true);
    expect(r.coverage).toMatchObject({ added: 0 });
    expect(r.coverage.total).toBeGreaterThan(0);
    expect(r.usage_advice.length).toBeGreaterThanOrEqual(3);
    // Usage is recorded against an operation id; the rule-based engine uses no analysis quota.
    const usage = await t.db.query.apiUsageRecords.findMany({ where: and(eq(apiUsageRecords.userId, user.id), isNotNull(apiUsageRecords.operationId)) });
    expect(usage.map((u) => u.requestType)).toEqual(["prompt_breakdown"]);
    expect(await t.db.query.usageEvents.findMany({ where: and(eq(usageEvents.userId, user.id), eq(usageEvents.eventType, "analysis")) })).toHaveLength(0);
    // Nothing is saved to the library.
    expect((await listPrompts(t.db, user.id)).total).toBe(0);
  });

  it("counts one analysis when a model plans it, and enforces the analysis quota", async () => {
    const user = await createUser(t.db, "bd-model");
    // The rule-based provider standing in for an open model (name "open", its own model id).
    const model = new Proxy(mock, {
      get(target, prop) {
        if (prop === "name") return "open";
        if (prop === "modelId") return "qwen2.5:7b";
        if (prop === "breakdownPrompt")
          return async (req: BreakdownRequest) => {
            const r = await target.breakdownPrompt(req);
            return { ...r, modelId: "qwen2.5:7b", attempts: r.attempts.map((a) => ({ ...a, modelId: "qwen2.5:7b" })) };
          };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as AiProvider;
    const r = await breakdownForUser(ctx(user, model), { source: { text: BIG } });
    expect(r.engine).toBe("model");
    expect(await t.db.query.usageEvents.findMany({ where: and(eq(usageEvents.userId, user.id), eq(usageEvents.eventType, "analysis")) })).toHaveLength(1);

    const limited = await createUser(t.db, "bd-quota");
    for (let i = 0; i < PLANS.free.analysesPerPeriod; i++) await t.db.insert(usageEvents).values({ userId: limited.id, eventType: "analysis", units: 1, idempotencyKey: `analysis:fill-${i}` });
    await expect(breakdownForUser(ctx(limited, model), { source: { text: BIG } })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("works on a saved prompt and rejects prompts that are too short", async () => {
    const user = await createUser(t.db, "bd-saved");
    const p = await createPrompt(t.db, user.id, PLANS.free, { category: "writing", versions: [{ promptText: BIG, provenance: "original" }] });
    const r = await breakdownForUser(ctx(user), { source: { promptId: p.id } });
    expect(r.prompt_id).toBe(p.id);
    await expect(breakdownForUser(ctx(user), { source: { text: "Write a poem." } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("saves every step as a tagged prompt, all or nothing", async () => {
    const user = await createUser(t.db, "bd-save");
    const r = await breakdownForUser(ctx(user), { source: { text: BIG } });
    const saved = await saveBreakdownSteps(ctx(user), { title: r.title, category: r.category, targetModel: "gpt-5-mini", steps: r.steps.map((s) => ({ title: s.title, prompt: s.prompt, how_to_use: s.how_to_use })) });
    expect(saved.prompts).toHaveLength(4);
    expect(saved.tag).toMatch(/^steps-write-a-case-study/);
    expect(saved.library_url).toBe(`/app/library?tag=${saved.tag}`);
    const first = await getPrompt(t.db, user.id, saved.prompts[0]!.id);
    expect(first).toMatchObject({ title: "1/4 Write a case study", tags: ["breakdown", saved.tag], category: "writing" });
    expect(first.versions[0]).toMatchObject({ provenance: "ai_optimised", promptText: r.steps[0]!.prompt });
    expect(first.description).toMatch(/^Step 1 of 4/);
    expect((await listPrompts(t.db, user.id, { tag: saved.tag })).total).toBe(4);

    // Over the plan's limit: nothing is saved.
    const full = await createUser(t.db, "bd-full");
    for (let i = 0; i < PLANS.free.maxSavedPrompts - 2; i++) await createPrompt(t.db, full.id, PLANS.free, { category: "general", versions: [{ promptText: `Prompt ${i}`, provenance: "original" }] });
    await expect(saveBreakdownSteps(ctx(full), { title: r.title, category: r.category, steps: r.steps.map((s) => ({ title: s.title, prompt: s.prompt })) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listPrompts(t.db, full.id)).total).toBe(PLANS.free.maxSavedPrompts - 2);
  });
});

describe("analysis hint", () => {
  it("tells the user when a prompt is worth breaking down", async () => {
    const { analyseForUser } = await import("@/lib/services/intelligence");
    const user = await createUser(t.db, "bd-hint");
    const big = await analyseForUser(ctx(user), { source: { text: BIG } });
    expect(big.breakdown).toMatchObject({ level: "recommended" });
    const small = await analyseForUser(ctx(user), { source: { text: "Write a haiku about the monsoon in Mumbai." } });
    expect(small.breakdown.level).toBe("single");
  });
});
