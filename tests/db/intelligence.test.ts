import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLANS } from "@/lib/config/plans";
import { apiUsageRecords, modelPricing, optimisationRuns, promptAnalyses, promptFeedbackEvents, tokenEstimates, usageEvents, type AppUser } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { ProviderError, type AiProvider } from "@/lib/providers/types";
import { setSuggestionStatus } from "@/lib/services/analysis";
import { requestAccountDeletion } from "@/lib/services/deletion";
import { analyseForUser, getStoredAnalysisView, recordRevisionSaved, reviseForUser, validateForUser, type IntelligenceContext } from "@/lib/services/intelligence";
import { saveLibraryVersion } from "@/lib/services/library";
import { getFeedbackCounts, resetFeedbackHistory } from "@/lib/services/prompt-preferences";
import { createPrompt, getPrompt } from "@/lib/services/prompts";
import { clearPricingCache } from "@/lib/services/pricing";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;
const mock = new MockOptimiserProvider();
const ctx = (user: AppUser, provider: AiProvider = mock): IntelligenceContext => ({ db: t.db, user, provider, requestId: crypto.randomUUID(), log: logger.withRequest("t"), globalDailySpendCapUsd: 0 });
const BAKERY = "Build an ecommerce website for my bakery. It must support online orders and pickup scheduling. Do not use WordPress.";

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function savedPrompt(user: AppUser, text = BAKERY) {
  return createPrompt(t.db, user.id, PLANS.free, { category: "coding", targetModel: "gpt-5-mini", versions: [{ promptText: text, provenance: "original" }] });
}

describe("analysis of unsaved text", () => {
  it("returns classification, rubric, requirements and suggestions without storing the prompt", async () => {
    const user = await createUser(t.db, "pi-adhoc");
    const r = await analyseForUser(ctx(user), { source: { text: BAKERY } });
    expect(r.stored).toBe(false);
    expect(r.classification).toMatchObject({ primary: "software_development", template: { id: "coding" } });
    expect(r.score.dimensions).toHaveLength(6);
    expect(r.requirements.map((x) => x.kind)).toEqual(["objective", "functional", "restriction"]);
    expect(r.missing_information.map((m) => m.key)).toContain("payment_provider");
    expect(r.token_estimate.token_count).toBeGreaterThan(0);
    expect(await t.db.query.promptAnalyses.findMany({ where: eq(promptAnalyses.userId, user.id) })).toHaveLength(0);
    // Provider usage is recorded against an operation id and consumes one analysis unit.
    const usage = await t.db.query.apiUsageRecords.findMany({ where: and(eq(apiUsageRecords.userId, user.id), isNotNull(apiUsageRecords.operationId)) });
    expect(usage).toHaveLength(1);
    expect((await t.db.query.usageEvents.findMany({ where: and(eq(usageEvents.userId, user.id), eq(usageEvents.eventType, "analysis")) })).length).toBe(1);
    // Re-analysing the same text is served from the short-lived cache: no new usage.
    const again = await analyseForUser(ctx(user), { source: { text: BAKERY } });
    expect(again.reused).toBe(true);
    expect(await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.userId, user.id) })).toHaveLength(1);
  });

  it("honours a manual category and rejects unsupported models and empty prompts", async () => {
    const user = await createUser(t.db, "pi-adhoc2");
    const r = await analyseForUser(ctx(user), { source: { text: "Write about our new running shoes" }, category: "marketing_seo" });
    expect(r.classification).toMatchObject({ primary: "marketing_seo", method: "user" });
    await expect(analyseForUser(ctx(user), { source: { text: "x" }, targetModel: "gpt-99" })).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
    await expect(analyseForUser(ctx(user), { source: { text: "   " } })).rejects.toMatchObject({ code: "PROMPT_EMPTY" });
  });
});

describe("analysis of a saved version", () => {
  it("stores the analysis against that exact version and marks it historical after a new version", async () => {
    const user = await createUser(t.db, "pi-saved");
    const p = await savedPrompt(user);
    const r = await analyseForUser(ctx(user), { source: { promptId: p.id } });
    expect(r.stored).toBe(true);
    expect(r.prompt_version_id).toBe(p.versions[0]!.id);
    expect(r.is_current).toBe(true);
    expect(r.requirements.map((x) => x.text)).toContain("Do not use WordPress.");
    expect(r.suggestions.every((s) => s.persisted)).toBe(true);
    const view = await getStoredAnalysisView(t.db, user.id, p.id, "gpt-5-mini");
    expect(view?.analysis_id).toBe(r.analysis_id);

    await saveLibraryVersion(t.db, user, p.id, { promptText: `${BAKERY} Use Stripe.` });
    expect(await getStoredAnalysisView(t.db, user.id, p.id, "gpt-5-mini")).toBeNull();
    const old = await analyseForUser(ctx(user), { source: { promptId: p.id, versionId: p.versions[0]!.id } });
    expect(old.reused).toBe(true);
    expect(old.is_current).toBe(false);
  });

  it("re-analyses when the user changes the category", async () => {
    const user = await createUser(t.db, "pi-cat");
    const p = await savedPrompt(user);
    const first = await analyseForUser(ctx(user), { source: { promptId: p.id } });
    const second = await analyseForUser(ctx(user), { source: { promptId: p.id }, category: "project_planning" });
    expect(second.analysis_id).not.toBe(first.analysis_id);
    expect(second.classification.primary).toBe("project_planning");
  });

  it("isolates users: another user's prompt is not found", async () => {
    const alice = await createUser(t.db, "pi-alice");
    const bob = await createUser(t.db, "pi-bob");
    const p = await savedPrompt(alice);
    await expect(analyseForUser(ctx(bob), { source: { promptId: p.id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reviseForUser(ctx(bob), { source: { promptId: p.id }, mode: "detailed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const a = await analyseForUser(ctx(alice), { source: { promptId: p.id } });
    const bobPrompt = await savedPrompt(bob);
    await expect(reviseForUser(ctx(bob), { source: { promptId: bobPrompt.id }, mode: "balanced", suggestionIds: [a.suggestions[0]!.id as string] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setSuggestionStatus(t.db, bob.id, a.suggestions[0]!.id as string, "dismissed")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("generation and optimisation", () => {
  it("returns a reviewable proposal with tokens, cost and preservation, and never overwrites the original", async () => {
    const user = await createUser(t.db, "pi-gen");
    const p = await savedPrompt(user);
    const r = await reviseForUser(ctx(user), { source: { promptId: p.id }, mode: "detailed", answers: { payment_provider: "Stripe" } });
    expect(r.revised_prompt).toContain("Payment provider: Stripe");
    expect(r.preservation.status).toBe("passed");
    expect(r.estimate.tokens_saved).toBeLessThan(0); // detailed prompts are longer, reported honestly
    expect(r.estimate.cost?.pricing_version).toBeTruthy();
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, r.revision_id) });
    expect(run).toMatchObject({ optimisationMode: "detailed", intentCategory: "software_development", preservationStatus: "passed", engine: "model", promptId: p.id, sourceVersionId: p.versions[0]!.id, resultVersionId: null });
    expect(JSON.stringify(run?.preservationReport)).not.toContain("WordPress"); // offsets only, no prompt text
    expect((await t.db.query.tokenEstimates.findMany({ where: eq(tokenEstimates.runId, r.revision_id) })).map((e) => e.label).sort()).toEqual(["optimised", "original"]);
    expect((await getPrompt(t.db, user.id, p.id)).versions).toHaveLength(1);

    // Accept and save: a new version linked to the run, plus a feedback event.
    const v = await saveLibraryVersion(t.db, user, p.id, { promptText: r.revised_prompt, optimisationId: r.revision_id });
    await recordRevisionSaved(t.db, user.id, { promptId: p.id, versionId: v.id, runId: r.revision_id });
    const saved = await getPrompt(t.db, user.id, p.id);
    expect(saved.versions.map((x) => x.provenance)).toEqual(["original", "ai_optimised"]);
    expect(saved.versions[0]!.promptText).toBe(BAKERY);
    const events = await t.db.query.promptFeedbackEvents.findMany({ where: eq(promptFeedbackEvents.userId, user.id) });
    expect(events.map((e) => e.eventType).sort()).toEqual(["mode_selected", "revision_saved"]);
    expect(events.find((e) => e.eventType === "revision_saved")?.optimisationMode).toBe("detailed");
  });

  it("applies accepted suggestions, marks them accepted and logs the decisions", async () => {
    const user = await createUser(t.db, "pi-apply");
    const p = await savedPrompt(user, "Please write a blog post about remote work. Please write a blog post about remote work.");
    const a = await analyseForUser(ctx(user), { source: { promptId: p.id } });
    const chosen = a.suggestions.filter((s) => s.category === "redundancy" || s.category === "output_format").map((s) => s.id as string);
    expect(chosen.length).toBe(2);
    const r = await reviseForUser(ctx(user), { source: { promptId: p.id }, mode: "balanced", suggestionIds: chosen });
    expect(r.suggestion_ids).toEqual(chosen);
    expect(r.revised_prompt.match(/remote work/g)).toHaveLength(1);
    expect(r.revised_prompt).toContain("[Add: format and length");
    const counts = await getFeedbackCounts(t.db, user.id);
    expect(counts.byKind["redundancy"]).toEqual({ accepted: 1, dismissed: 0 });
  });

  it("does not consume quota when the token saver needs no model call; respects budgets", async () => {
    const user = await createUser(t.db, "pi-local");
    const text = "Please could you write a haiku about autumn leaves. Please could you write a haiku about autumn leaves.";
    const r = await reviseForUser(ctx(user), { source: { text }, mode: "token_saver" });
    expect(r.engine).toBe("local");
    expect(r.revised_prompt).toBe("Write a haiku about autumn leaves.");
    expect(r.estimate.tokens_saved).toBeGreaterThan(0);
    expect(await t.db.query.usageEvents.findMany({ where: and(eq(usageEvents.userId, user.id), eq(usageEvents.eventType, "optimisation")) })).toHaveLength(0);
    const tight = await reviseForUser(ctx(user), { source: { text: BAKERY }, mode: "token_saver", tokenBudget: 10 });
    expect(tight.budget).toMatchObject({ requested: 10, met: false });
    expect(tight.preservation.status).not.toBe("failed");
  });

  it("records a failed run with the provider's attempts and leaves nothing saved", async () => {
    const user = await createUser(t.db, "pi-fail");
    const failing = Object.assign(Object.create(mock), {
      revisePrompt: async () => {
        throw new ProviderError("PROVIDER_TIMEOUT", "timeout", { attempts: [{ attempt: 1, status: "error", usage: null, modelId: "mock-optimiser", errorCode: "PROVIDER_TIMEOUT:timeout" }] });
      },
    }) as AiProvider;
    await expect(reviseForUser(ctx(user, failing), { source: { text: BAKERY }, mode: "detailed" })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.userId, user.id) });
    expect(run).toMatchObject({ status: "failed", errorCode: "PROVIDER_TIMEOUT:timeout" });
    expect(await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.runId, run!.id) })).toHaveLength(1);
    expect(await t.db.query.usageEvents.findMany({ where: and(eq(usageEvents.userId, user.id), eq(usageEvents.eventType, "optimisation")) })).toHaveLength(0);
  });

  it("enforces the optimisation quota and requires an objective for custom mode", async () => {
    const user = await createUser(t.db, "pi-quota");
    await expect(reviseForUser(ctx(user), { source: { text: BAKERY }, mode: "custom" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await t.db.insert(usageEvents).values(Array.from({ length: PLANS.free.optimisationsPerPeriod }, () => ({ userId: user.id, eventType: "optimisation", units: 1 })));
    await expect(reviseForUser(ctx(user), { source: { text: BAKERY }, mode: "detailed" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("still returns token counts when pricing is missing", async () => {
    const user = await createUser(t.db, "pi-noprice");
    await t.db.update(modelPricing).set({ effectiveTo: new Date("2000-01-01"), effectiveFrom: new Date("1999-01-01") }).where(eq(modelPricing.modelId, "gpt-4o"));
    clearPricingCache();
    const r = await validateForUser(ctx(user), { original: BAKERY, revised: `${BAKERY} Use Stripe.`, targetModel: "gpt-4o" });
    expect(r.estimate.cost).toBeNull();
    expect(r.estimate.pricing_warning).toMatch(/No pricing/);
    expect(r.estimate.original.token_count).toBeGreaterThan(0);
  });
});

describe("validation and feedback controls", () => {
  it("validates a hand-edited revision deterministically", async () => {
    const user = await createUser(t.db, "pi-validate");
    const r = await validateForUser(ctx(user), { original: BAKERY, revised: "Build an ecommerce website for my bakery. It must support online orders." });
    expect(r.preservation.status).toBe("failed");
    expect(r.preservation.checks.find((c) => c.status === "missing")?.text).toBe("Do not use WordPress.");
    expect(r.semantic_checked).toBe(false);
  });

  it("can forget learned feedback, and deletes it with the account", async () => {
    const user = await createUser(t.db, "pi-forget");
    const p = await savedPrompt(user);
    const a = await analyseForUser(ctx(user), { source: { promptId: p.id } });
    await setSuggestionStatus(t.db, user.id, a.suggestions[0]!.id as string, "dismissed");
    expect(Object.keys((await getFeedbackCounts(t.db, user.id)).byKind)).toHaveLength(1);
    await resetFeedbackHistory(t.db, user.id);
    expect((await getFeedbackCounts(t.db, user.id)).byKind).toEqual({});
    await setSuggestionStatus(t.db, user.id, a.suggestions[1]!.id as string, "accepted");
    await requestAccountDeletion(t.db, user.id);
    expect(await t.db.query.promptFeedbackEvents.findMany({ where: eq(promptFeedbackEvents.userId, user.id) })).toHaveLength(0);
  });
});

describe("studio: saved preferences and auto-save", () => {
  it("applies saved preferences unless the prompt says otherwise, and auto-saves once", async () => {
    const { upsertPreference } = await import("@/lib/services/preferences");
    const { listPrompts } = await import("@/lib/services/prompts");
    const user = await createUser(t.db, "studio-auto");
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "tone", preferenceValue: { value: "friendly" }, source: "user_entered" });
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "format", preferenceValue: { value: "bullet_points" }, source: "user_entered" });

    const r = await reviseForUser(ctx(user), { source: { text: "Write a newsletter intro about our spring sale as a short paragraph." }, mode: "balanced" });
    expect(r.preferences_applied.effective).toEqual({ tone: "friendly" });
    expect(r.preferences_applied.skipped_because_prompt_says_otherwise).toEqual(["format"]);
    expect(r.revised_prompt).toContain("Use a warm, friendly tone.");
    expect(r.revised_prompt).not.toContain("bullet points");
    expect(r.auto_saved).not.toBeNull();
    const saved = await getPrompt(t.db, user.id, r.auto_saved!.prompt_id);
    expect(saved.versions.map((v) => v.provenance)).toEqual(["original", "ai_optimised"]);
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, r.revision_id) });
    expect(run).toMatchObject({ promptId: saved.id, resultVersionId: r.auto_saved!.proposed_version_id });

    // A further draft of the saved prompt is not auto-saved again.
    const again = await reviseForUser(ctx(user), { source: { promptId: saved.id, versionId: r.auto_saved!.original_version_id }, mode: "detailed" });
    expect(again.auto_saved).toBeNull();
    expect((await listPrompts(t.db, user.id)).total).toBe(1);
  });

  it("does not auto-save when the setting is off, and ignores preferences when personalisation is off", async () => {
    const { upsertPreference } = await import("@/lib/services/preferences");
    const user = await createUser(t.db, "studio-off", { historyEnabled: false, personalisationEnabled: false });
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "tone", preferenceValue: { value: "formal" }, source: "user_entered" });
    const r = await reviseForUser(ctx(user), { source: { text: "Write a thank-you note to our volunteers." }, mode: "balanced" });
    expect(r.auto_saved).toBeNull();
    expect(r.preferences_applied.effective).toEqual({});
    expect(r.revised_prompt).not.toContain("formal tone");
  });
});
