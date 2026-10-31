import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/lib/api/errors";
import { PLANS } from "@/lib/config/plans";
import { apiUsageRecords, optimisationRuns, promptAnalyses, promptSuggestions, prompts, promptVersions, type AppUser } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { optimisePromptForUser, type OptimiseServiceContext } from "@/lib/optimiser/service";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { ProviderError, type AiProvider } from "@/lib/providers/types";
import { analysePrompt, getLatestAnalysis, listSuggestions, setSuggestionStatus, type AnalyseContext } from "@/lib/services/analysis";
import { invalidateDashboard } from "@/lib/services/dashboard-cache";
import { getDashboardAnalytics, getDashboardSummary, listOptimisationHistory } from "@/lib/services/dashboard";
import { requestAccountDeletion } from "@/lib/services/deletion";
import { buildAccountExport } from "@/lib/services/exports";
import { optimiseLibraryPrompt, saveLibraryVersion } from "@/lib/services/library";
import { getFeedbackHistory, updatePromptPreferences } from "@/lib/services/prompt-preferences";
import {
  createPrompt,
  deletePrompt,
  deriveTitle,
  duplicatePrompt,
  getPrompt,
  listPrompts,
  markPromptUsed,
  restoreVersion,
  updatePrompt,
} from "@/lib/services/prompts";
import { getUsageSummary } from "@/lib/services/usage";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const mock = new MockOptimiserProvider();

function optCtx(user: AppUser, provider: AiProvider = mock): OptimiseServiceContext {
  return { db: t.db, user, provider, requestId: crypto.randomUUID(), idempotencyKey: null, log: logger.withRequest("t"), globalDailySpendCapUsd: 0, maxOutputTokensCeiling: 1500 };
}
function anCtx(user: AppUser, provider: AiProvider = mock): AnalyseContext {
  return { db: t.db, user, provider, requestId: crypto.randomUUID(), log: logger.withRequest("t"), globalDailySpendCapUsd: 0 };
}
async function newPrompt(user: AppUser, text: string, extra: Partial<Parameters<typeof createPrompt>[3]> = {}) {
  return createPrompt(t.db, user.id, PLANS.pro, { category: "writing", versions: [{ promptText: text, provenance: "original" }], ...extra });
}

const VERBOSE =
  "Please could you write me some stuff about our new product launch. Please could you write me some stuff about our new product launch. I would like you to make it good and also short but detailed.";

describe("saving (§3; criteria 1, 2, 3)", () => {
  it("auto-saves an optimised prompt when auto-save (history) is on, with metadata", async () => {
    const user = await createUser(t.db, "lib-auto");
    const r = await optimisePromptForUser(optCtx(user), { prompt: "write a launch email for our product", taskCategory: "writing", options: { targetModel: "gpt-4o" } });
    const saved = await getPrompt(t.db, user.id, r.saved_prompt_id as string);
    expect(saved.versions.map((v) => v.provenance)).toEqual(["original", "ai_optimised"]);
    expect(saved).toMatchObject({ targetModel: "gpt-4o", currentVersionNumber: 2, optimisationCount: 1 });
    expect(saved.originalTokenCount).toBe(saved.versions[0]?.tokenEstimate);
    expect(saved.versions[1]?.tokenizerVersion).toMatch(/^js-tiktoken@/);
    expect(saved.versions[0]?.createdBy).toBe(user.id);
  });

  it("does not save when auto-save is off; manual save still works", async () => {
    const user = await createUser(t.db, "lib-manual", { historyEnabled: false });
    const r = await optimisePromptForUser(optCtx(user), { prompt: "summarise the meeting notes", taskCategory: "summarisation" });
    expect(r.saved_prompt_id).toBeNull();
    expect((await listPrompts(t.db, user.id)).total).toBe(0);
    const p = await newPrompt(user, "summarise the meeting notes");
    expect((await listPrompts(t.db, user.id)).items.map((i) => i.id)).toEqual([p.id]);
  });

  it("derives a readable default title without AI", () => {
    expect(deriveTitle("\n\nWrite a launch email\nwith details")).toBe("Write a launch email");
    expect(deriveTitle("x".repeat(10) + " " + "word ".repeat(30)).endsWith("…")).toBe(true);
    expect(deriveTitle("   ")).toBe("Untitled prompt");
  });

  it("rejects an unsupported target model", async () => {
    const user = await createUser(t.db, "lib-model");
    await expect(newPrompt(user, "hi", { targetModel: "gpt-9" })).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
  });
});

describe("library listing (§4; criterion 4)", () => {
  it("searches title, text and tags; filters; sorts; paginates — owner only", async () => {
    const user = await createUser(t.db, "lib-list");
    const other = await createUser(t.db, "lib-list-other");
    const a = await newPrompt(user, "Draft a postmortem for the outage", { title: "Postmortem", tags: ["ops"], targetModel: "gpt-4o" });
    const b = await newPrompt(user, "Summarise the quarterly numbers for the board in five bullet points and a table", { title: "Board summary", category: "summarisation" });
    const c = await newPrompt(user, "Write a regex for UK postcodes", { title: "Regex", category: "coding" });
    await newPrompt(other, "Postmortem of someone else", { title: "Postmortem" });

    await updatePrompt(t.db, user.id, c.id, { isFavourite: true });
    await markPromptUsed(t.db, user.id, b.id);
    await markPromptUsed(t.db, user.id, b.id);

    expect((await listPrompts(t.db, user.id, { search: "postmortem" })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await listPrompts(t.db, user.id, { search: "quarterly" })).items.map((i) => i.id)).toEqual([b.id]);
    expect((await listPrompts(t.db, user.id, { search: "ops" })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await listPrompts(t.db, user.id, { favourite: true })).items.map((i) => i.id)).toEqual([c.id]);
    expect((await listPrompts(t.db, user.id, { targetModel: "gpt-4o" })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await listPrompts(t.db, user.id, { category: "coding" })).total).toBe(1);
    expect((await listPrompts(t.db, user.id, { sort: "most_used" })).items[0]?.id).toBe(b.id);
    expect((await listPrompts(t.db, user.id, { sort: "largest" })).items[0]?.id).toBe(b.id);
    expect((await listPrompts(t.db, user.id, { sort: "oldest" })).items[0]?.id).toBe(a.id);
    const page2 = await listPrompts(t.db, user.id, { pageSize: 2, page: 2 });
    expect(page2.total).toBe(3);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.latestVersion?.promptText).toBeTruthy();

    await updatePrompt(t.db, user.id, a.id, { archived: true });
    expect((await listPrompts(t.db, user.id)).total).toBe(2);
    expect((await listPrompts(t.db, user.id, { archivedOnly: true })).items.map((i) => i.id)).toEqual([a.id]);
  });
});

describe("versions, duplicate, restore (§2; criteria 6, 10)", () => {
  it("restores an earlier version as a new version and keeps history", async () => {
    const user = await createUser(t.db, "lib-restore");
    const p = await newPrompt(user, "v1 text here");
    await saveLibraryVersion(t.db, user, p.id, { promptText: "v2 text here, longer than before" });
    const v1 = p.versions[0]!;
    const restored = await restoreVersion(t.db, user.id, PLANS.pro, p.id, v1.id);
    expect(restored).toMatchObject({ versionNumber: 3, provenance: "restored", promptText: "v1 text here", parentVersionId: v1.id });
    const full = await getPrompt(t.db, user.id, p.id);
    expect(full.versions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
    expect(full.currentVersionId).toBe(restored.id);
    expect(full.currentTokenCount).toBe(v1.tokenEstimate);
  });

  it("duplicates the current version into a new prompt", async () => {
    const user = await createUser(t.db, "lib-dup");
    const p = await newPrompt(user, "original text", { title: "Mine", tags: ["a"] });
    await saveLibraryVersion(t.db, user, p.id, { promptText: "edited text" });
    const copy = await duplicatePrompt(t.db, user.id, PLANS.pro, p.id);
    expect(copy.title).toBe("Copy of Mine");
    expect(copy.versions).toHaveLength(1);
    expect(copy.versions[0]).toMatchObject({ provenance: "duplicated", promptText: "edited text" });
    expect(copy.tags).toEqual(["a"]);
  });
});

describe("analysis and suggestions (§5–6; criteria 7, 8, 15)", () => {
  it("links the analysis and its suggestions to the analysed version and updates library stats", async () => {
    const user = await createUser(t.db, "an-link");
    const p = await newPrompt(user, VERBOSE);
    const res = await analysePrompt(anCtx(user), { promptId: p.id });
    expect(res.reused).toBe(false);
    expect(res.analysis.promptVersionId).toBe(p.versions[0]?.id);
    expect(res.suggestions.length).toBeGreaterThan(2);
    expect(res.suggestions.every((s) => s.promptVersionId === p.versions[0]?.id)).toBe(true);
    const categories = res.suggestions.map((s) => s.category);
    expect(categories).toEqual(expect.arrayContaining(["contradictions", "redundancy"]));
    // Version-linked structured analysis: category, rubric and requirement offsets (no prompt text).
    expect(res.analysis.taskCategory).toBeTruthy();
    expect((res.analysis.dimensionScores as unknown[]).length).toBe(6);
    const checklist = res.analysis.requirementChecklist as Array<{ start: number; end: number }>;
    expect(checklist.length).toBeGreaterThan(0);
    expect(VERBOSE.slice(checklist[0]!.start, checklist[0]!.end).length).toBeGreaterThan(0);
    expect(res.suggestions.every((s) => s.expectedBenefit && s.recommendationScore !== null)).toBe(true);
    const reloaded = await getPrompt(t.db, user.id, p.id);
    expect(reloaded.latestQualityScore).toBe(res.analysis.qualityScore);
    expect(reloaded.pendingSuggestionCount).toBe(res.suggestions.length);
    expect(reloaded.pendingPriority).toBe(3);
    // Provider usage is attributed to the analysis.
    expect((await t.db.query.apiUsageRecords.findMany({ where: eq(apiUsageRecords.analysisId, res.analysis.id) })).length).toBe(1);
  });

  it("reuses the stored analysis of an unchanged version unless forced", async () => {
    const user = await createUser(t.db, "an-reuse");
    const p = await newPrompt(user, VERBOSE);
    const first = await analysePrompt(anCtx(user), { promptId: p.id });
    const again = await analysePrompt(anCtx(user), { promptId: p.id });
    expect(again.reused).toBe(true);
    expect(again.analysis.id).toBe(first.analysis.id);
    const forced = await analysePrompt(anCtx(user), { promptId: p.id, force: true });
    expect(forced.analysis.id).not.toBe(first.analysis.id);
    expect((await t.db.query.promptAnalyses.findMany({ where: eq(promptAnalyses.promptId, p.id) })).length).toBe(2);
  });

  it("reports an already well-optimised prompt explicitly", async () => {
    const user = await createUser(t.db, "an-good");
    const p = await newPrompt(user, "Write a 120-word LinkedIn post for software engineers announcing our Manchester office opening on 3 November. Use an upbeat, professional tone. Format: one paragraph, no emoji.");
    const res = await analysePrompt(anCtx(user), { promptId: p.id });
    expect(res.analysis.alreadyOptimised).toBe(true);
    expect(res.suggestions).toHaveLength(0);
  });

  it("accepts, dismisses, defers and refuses changes to applied suggestions", async () => {
    const user = await createUser(t.db, "an-status");
    const p = await newPrompt(user, VERBOSE);
    const { suggestions } = await analysePrompt(anCtx(user), { promptId: p.id });
    const [s1, s2, s3] = suggestions;
    expect((await setSuggestionStatus(t.db, user.id, s1!.id, "accepted")).status).toBe("accepted");
    expect((await setSuggestionStatus(t.db, user.id, s2!.id, "dismissed")).feedbackAt).not.toBeNull();
    expect((await setSuggestionStatus(t.db, user.id, s3!.id, "deferred")).status).toBe("deferred");
    await expect(setSuggestionStatus(t.db, user.id, s1!.id, "applied")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await saveLibraryVersion(t.db, user, p.id, { promptText: "rewritten", suggestionIds: [s1!.id] });
    await expect(setSuggestionStatus(t.db, user.id, s1!.id, "pending")).rejects.toMatchObject({ code: "CONFLICT" });
    const applied = await t.db.query.promptSuggestions.findFirst({ where: eq(promptSuggestions.id, s1!.id) });
    expect(applied?.status).toBe("applied");
    expect((await listSuggestions(t.db, user.id, { status: ["deferred"] })).map((s) => s.id)).toEqual([s3!.id]);
  });

  it("personalises ranking from explicit decisions and preferences, and can be switched off", async () => {
    const user = await createUser(t.db, "an-personal");
    const text = "Please could you write a blog post about our new product launch for the blog. Please could you write a blog post about our new product launch for the blog.";
    const p1 = await newPrompt(user, text);
    const before = await analysePrompt(anCtx(user), { promptId: p1.id });
    const redundancy = before.suggestions.find((s) => s.category === "redundancy")!;
    const baseline = Number(redundancy.recommendationScore);

    // Dismiss the redundancy suggestion on several prompts; each decision is logged as a feedback event.
    await setSuggestionStatus(t.db, user.id, redundancy.id, "dismissed");
    for (let i = 0; i < 9; i++) {
      const p = await newPrompt(user, `${text} ${i}`);
      const r = await analysePrompt(anCtx(user), { promptId: p.id });
      await setSuggestionStatus(t.db, user.id, r.suggestions.find((s) => s.category === "redundancy")!.id, "dismissed");
    }
    expect((await getFeedbackHistory(t.db, user.id))["redundancy"]).toEqual({ accepted: 0, dismissed: 10 });
    const after = await analysePrompt(anCtx(user), { promptId: (await newPrompt(user, `${text} again`)).id });
    expect(Number(after.suggestions.find((s) => s.category === "redundancy")!.recommendationScore)).toBeLessThan(baseline);

    // An explicit preference raises token suggestions; switching learning off ignores the history.
    await updatePromptPreferences(t.db, user.id, { tokenEfficiencyPriority: "high", learnFromFeedback: false });
    const off = await analysePrompt(anCtx(user), { promptId: (await newPrompt(user, `${text} off`)).id });
    expect(Number(off.suggestions.find((s) => s.category === "redundancy")!.recommendationScore)).toBeGreaterThan(baseline);
  });

  it("enforces the analysis quota (criterion 17)", async () => {
    const user = await createUser(t.db, "an-quota");
    for (let i = 0; i < PLANS.free.analysesPerPeriod; i++) {
      const p = await newPrompt(user, `${VERBOSE} ${i}`);
      await analysePrompt(anCtx(user), { promptId: p.id });
    }
    const p = await newPrompt(user, `${VERBOSE} last`);
    await expect(analysePrompt(anCtx(user), { promptId: p.id })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("a failed analysis stores no suggestions and is marked failed", async () => {
    const user = await createUser(t.db, "an-fail");
    const p = await newPrompt(user, VERBOSE);
    const failing = Object.assign(Object.create(mock), {
      analyseIntent: async () => {
        throw new ProviderError("PROVIDER_TIMEOUT", "timeout");
      },
    }) as AiProvider;
    await expect(analysePrompt(anCtx(user, failing), { promptId: p.id })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    const rows = await t.db.query.promptAnalyses.findMany({ where: eq(promptAnalyses.promptId, p.id) });
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
    expect(await getLatestAnalysis(t.db, user.id, p.id)).toBeNull();
    // A retry is allowed after failure.
    expect((await analysePrompt(anCtx(user), { promptId: p.id })).reused).toBe(false);
  });
});

describe("library optimisation (§6–7; criteria 9, 10, 11, 14)", () => {
  it("returns a proposal without touching versions; saving links run, version and applied suggestions", async () => {
    const user = await createUser(t.db, "opt-flow");
    const p = await newPrompt(user, VERBOSE, { targetModel: "gpt-4o" });
    const { suggestions } = await analysePrompt(anCtx(user), { promptId: p.id });
    const chosen = suggestions.filter((s) => s.category === "repetition" || s.category === "verbosity").map((s) => s.id);

    const proposal = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "token_saver", suggestionIds: chosen });
    expect(proposal.optimisation_mode).toBe("token_saver");
    expect(proposal.applied_suggestion_count).toBe(chosen.length);
    expect(proposal.estimate.model).toBe("gpt-4o");
    expect(proposal.estimate.tokens_saved).toBe(proposal.estimate.original.token_count - proposal.estimate.optimised.token_count);
    // Never overwritten automatically: still one version.
    expect((await getPrompt(t.db, user.id, p.id)).versions).toHaveLength(1);
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, proposal.optimisation_id) });
    expect(run).toMatchObject({ promptId: p.id, sourceVersionId: p.versions[0]?.id, optimisationMode: "token_saver", targetModel: "gpt-4o", resultVersionId: null });
    expect(run?.tokensSaved).toBe(proposal.estimate.tokens_saved);

    const v2 = await saveLibraryVersion(t.db, user, p.id, { promptText: proposal.optimised_prompt, optimisationId: proposal.optimisation_id, suggestionIds: chosen });
    expect(v2).toMatchObject({ versionNumber: 2, provenance: "ai_optimised", optimisationRunId: proposal.optimisation_id, parentVersionId: p.versions[0]?.id });
    expect((await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, proposal.optimisation_id) }))?.resultVersionId).toBe(v2.id);
    const stats = await getPrompt(t.db, user.id, p.id);
    expect(stats.currentTokenCount).toBe(v2.tokenEstimate);
    expect(stats.originalTokenCount).toBe(p.versions[0]?.tokenEstimate);
    expect(stats.optimisationCount).toBe(1);
    // The same run cannot be saved twice.
    await expect(saveLibraryVersion(t.db, user, p.id, { promptText: "again", optimisationId: proposal.optimisation_id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("handles a longer optimised prompt as a negative saving", async () => {
    const user = await createUser(t.db, "opt-neg");
    const p = await newPrompt(user, "Write a summary of the attached notes for my manager");
    const r = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "quality_first" });
    expect(r.estimate.tokens_saved).toBeLessThan(0);
    expect(r.estimate.reduction_percent).toBeLessThan(0);
    await saveLibraryVersion(t.db, user, p.id, { promptText: r.optimised_prompt, optimisationId: r.optimisation_id });
    const summary = await getDashboardSummary(t.db, user.id);
    expect(summary.tokens_saved.net_tokens_saved).toBeLessThan(0);
    expect(summary.tokens_saved.prompts_increased).toBe(1);
  });

  it("optimises the user's edited revision and recounts", async () => {
    const user = await createUser(t.db, "opt-edit");
    const p = await newPrompt(user, "Please write some things about cats.");
    const r = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, text: "Please please write a long essay about cats and dogs for children.", mode: "balanced" });
    expect(r.original_prompt).toContain("cats and dogs");
    expect(r.source_version_id).toBe(p.versions[0]?.id);
  });

  it("requires an objective for custom mode", async () => {
    const user = await createUser(t.db, "opt-custom");
    const p = await newPrompt(user, "x y z");
    await expect(optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "custom" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const r = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "custom", customObjective: "Make it suitable for a 10-year-old" });
    expect(r.change_summary.join(" ")).toMatch(/10-year-old/);
  });

  it("a provider failure creates no version and leaves the prompt intact", async () => {
    const user = await createUser(t.db, "opt-fail");
    const p = await newPrompt(user, VERBOSE);
    const failing = Object.assign(Object.create(mock), {
      optimise: async () => {
        throw new ProviderError("PROVIDER_UNAVAILABLE", "upstream_error");
      },
    }) as AiProvider;
    await expect(optimiseLibraryPrompt(optCtx(user, failing), { promptId: p.id })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const after = await getPrompt(t.db, user.id, p.id);
    expect(after.versions).toHaveLength(1);
    expect(after.latestOptimisationStatus).toBe("failed");
    expect(after.optimisationCount).toBe(0);
    // A failed run cannot be saved as a version.
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.promptId, p.id) });
    await expect(saveLibraryVersion(t.db, user, p.id, { promptText: "x", optimisationId: run!.id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getUsageSummary(t.db, user)).used).toBe(0);
  });
});

describe("ownership (§13; criterion 5)", () => {
  it("blocks every cross-user prompt, suggestion and optimisation operation", async () => {
    const owner = await createUser(t.db, "own-a");
    const intruder = await createUser(t.db, "own-b");
    const p = await newPrompt(owner, VERBOSE);
    const { suggestions } = await analysePrompt(anCtx(owner), { promptId: p.id });
    const proposal = await optimiseLibraryPrompt(optCtx(owner), { promptId: p.id });

    const notFound = { code: "NOT_FOUND" };
    await expect(analysePrompt(anCtx(intruder), { promptId: p.id })).rejects.toMatchObject(notFound);
    await expect(setSuggestionStatus(t.db, intruder.id, suggestions[0]!.id, "dismissed")).rejects.toMatchObject(notFound);
    await expect(optimiseLibraryPrompt(optCtx(intruder), { promptId: p.id })).rejects.toMatchObject(notFound);
    await expect(restoreVersion(t.db, intruder.id, PLANS.pro, p.id, p.versions[0]!.id)).rejects.toMatchObject(notFound);
    await expect(duplicatePrompt(t.db, intruder.id, PLANS.pro, p.id)).rejects.toMatchObject(notFound);
    await expect(markPromptUsed(t.db, intruder.id, p.id)).rejects.toMatchObject(notFound);
    await expect(saveLibraryVersion(t.db, intruder, p.id, { promptText: "x" })).rejects.toMatchObject(notFound);

    // The intruder's own prompt cannot borrow the owner's run or suggestions.
    const theirs = await newPrompt(intruder, "my own");
    await expect(saveLibraryVersion(t.db, intruder, theirs.id, { promptText: "x", optimisationId: proposal.optimisation_id })).rejects.toMatchObject(notFound);
    await expect(saveLibraryVersion(t.db, intruder, theirs.id, { promptText: "x", suggestionIds: [suggestions[0]!.id] })).rejects.toMatchObject(notFound);
    await expect(optimiseLibraryPrompt(optCtx(intruder), { promptId: theirs.id, suggestionIds: [suggestions[0]!.id] })).rejects.toBeInstanceOf(AppError);
    expect(await listSuggestions(t.db, intruder.id)).toHaveLength(0);
  });
});

describe("dashboard metrics (§11; criterion 12)", () => {
  it("counts token savings once per prompt, however many runs", async () => {
    const user = await createUser(t.db, "dash");
    const p = await newPrompt(user, VERBOSE, { targetModel: "gpt-4o" });
    const r1 = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "token_saver" });
    await saveLibraryVersion(t.db, user, p.id, { promptText: r1.optimised_prompt, optimisationId: r1.optimisation_id });
    const r2 = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id, mode: "token_saver" });
    await saveLibraryVersion(t.db, user, p.id, { promptText: r2.optimised_prompt, optimisationId: r2.optimisation_id });

    const full = await getPrompt(t.db, user.id, p.id);
    const expected = (full.originalTokenCount ?? 0) - (full.currentTokenCount ?? 0);
    invalidateDashboard(user.id);
    const summary = await getDashboardSummary(t.db, user.id);
    expect(summary.tokens_saved.net_tokens_saved).toBe(expected);
    expect(summary.tokens_saved.net_tokens_saved).toBeLessThan(r1.estimate.tokens_saved + r2.estimate.tokens_saved + 1);
    expect(summary.tokens_saved.kind).toBe("estimate");
    expect(summary.prompts_optimised).toBe(1);
    expect(summary.estimated_cost_savings.complete).toBe(true);
    expect(summary.estimated_cost_savings.estimated_input_cost_saved_per_request).toBeCloseTo((expected * 2.5) / 1e6, 9);

    const analytics = await getDashboardAnalytics(t.db, user.id);
    const tokenSaver = analytics.optimisation_runs.by_mode.find((m) => m.mode === "token_saver");
    expect(tokenSaver?.runs).toBe(2);
    expect(analytics.recent_activity.length).toBeGreaterThan(0);
    // Titles are the owner's metadata; prompt text beyond the title never appears.
    expect(JSON.stringify(analytics)).not.toContain("short but detailed");
    const history = await listOptimisationHistory(t.db, user.id, 1, 10);
    expect(history.items.map((i) => i.saved_as_version)).toEqual([true, true]);
  });

  it("flags incomplete cost estimates when a model has no pricing (criterion 13)", async () => {
    const user = await createUser(t.db, "dash-unpriced");
    const p = await newPrompt(user, VERBOSE, { targetModel: "gpt-5.4" });
    await saveLibraryVersion(t.db, user, p.id, { promptText: "Shorter." });
    const summary = await getDashboardSummary(t.db, user.id);
    expect(summary.estimated_cost_savings.complete).toBe(false);
    expect(summary.estimated_cost_savings.unpriced_models).toEqual(["gpt-5.4"]);
    expect((await getPrompt(t.db, user.id, p.id)).latestEstimatedCost).toBeNull();
  });

  it("invalidates the cached summary when the library changes", async () => {
    const user = await createUser(t.db, "dash-cache");
    expect((await getDashboardSummary(t.db, user.id)).total_prompts).toBe(0);
    await newPrompt(user, "new prompt");
    expect((await getDashboardSummary(t.db, user.id)).total_prompts).toBe(1);
  });
});

describe("deletion and export (§3, §13; criterion 16)", () => {
  it("deleting a prompt removes versions, analyses and suggestions but keeps run metadata", async () => {
    const user = await createUser(t.db, "del-prompt");
    const p = await newPrompt(user, VERBOSE);
    await analysePrompt(anCtx(user), { promptId: p.id });
    const r = await optimiseLibraryPrompt(optCtx(user), { promptId: p.id });
    await deletePrompt(t.db, user.id, p.id);
    expect(await t.db.query.promptVersions.findMany({ where: eq(promptVersions.promptId, p.id) })).toHaveLength(0);
    expect(await t.db.query.promptAnalyses.findMany({ where: eq(promptAnalyses.promptId, p.id) })).toHaveLength(0);
    expect(await t.db.query.promptSuggestions.findMany({ where: eq(promptSuggestions.promptId, p.id) })).toHaveLength(0);
    const run = await t.db.query.optimisationRuns.findFirst({ where: eq(optimisationRuns.id, r.optimisation_id) });
    expect(run?.promptId).toBeNull();
  });

  it("account export includes analyses, suggestions and prompt preferences; deletion removes them", async () => {
    const user = await createUser(t.db, "del-account");
    const p = await newPrompt(user, VERBOSE);
    await analysePrompt(anCtx(user), { promptId: p.id });
    await updatePromptPreferences(t.db, user.id, { domains: ["marketing emails"] });
    const doc = await buildAccountExport(t.db, user);
    expect(doc.analyses).toHaveLength(1);
    expect(doc.suggestions.length).toBeGreaterThan(0);
    expect(doc.prompt_preferences.domains).toEqual(["marketing emails"]);

    await requestAccountDeletion(t.db, user.id);
    expect(await t.db.query.prompts.findMany({ where: eq(prompts.userId, user.id) })).toHaveLength(0);
    expect(await t.db.query.promptSuggestions.findMany({ where: eq(promptSuggestions.userId, user.id) })).toHaveLength(0);
  });
});
