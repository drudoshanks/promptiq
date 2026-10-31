import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/lib/api/errors";
import { PLANS } from "@/lib/config/plans";
import type { AppUser } from "@/lib/db/schema";
import { deleteFeedback, submitFeedback } from "@/lib/services/feedback";
import { deletePreference, listPreferences, patchPreference, upsertPreference } from "@/lib/services/preferences";
import { addVersion, createPrompt, deletePrompt, getPrompt, listPrompts, updatePrompt } from "@/lib/services/prompts";
import { getRun, recordRun } from "@/lib/services/usage";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;
let alice: AppUser;
let bob: AppUser;

beforeAll(async () => {
  t = await createTestDb();
  alice = await createUser(t.db, "alice");
  bob = await createUser(t.db, "bob");
});

afterAll(async () => {
  await t.close();
});

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const rows = (await t.client.query("SELECT name FROM schema_migrations ORDER BY name")).rows as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["0001_init.sql", "0002_row_level_security.sql", "0003_token_cost_engine.sql", "0004_prompt_library.sql", "0005_prompt_intelligence.sql", "0006_upi_payments.sql"]);
  });

  it("create every table from SRS §9.1", async () => {
    const rows = (await t.client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows as Array<{ tablename: string }>;
    const names = rows.map((r) => r.tablename);
    for (const table of ["app_users", "user_preferences", "prompts", "prompt_versions", "optimisation_runs", "feedback", "usage_events", "subscriptions", "webhook_events", "deletion_jobs", "model_pricing", "token_estimates", "api_usage_records"]) {
      expect(names).toContain(table);
    }
  });
});

describe("cross-account isolation (NFR-002, §13.2)", () => {
  it("a user cannot read, update, version, export-list or delete another user's prompt", async () => {
    const prompt = await createPrompt(t.db, alice.id, PLANS.free, {
      title: "Alice's prompt",
      category: "writing",
      versions: [{ promptText: "Write a thing", provenance: "original" }],
    });

    await expect(getPrompt(t.db, bob.id, prompt.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updatePrompt(t.db, bob.id, prompt.id, { title: "stolen" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addVersion(t.db, bob.id, PLANS.free, prompt.id, { promptText: "x", provenance: "user_edited" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deletePrompt(t.db, bob.id, prompt.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const bobsList = await listPrompts(t.db, bob.id);
    expect(bobsList.items.find((p) => p.id === prompt.id)).toBeUndefined();

    const stillThere = await getPrompt(t.db, alice.id, prompt.id);
    expect(stillThere.title).toBe("Alice's prompt");
  });

  it("a user cannot edit or delete another user's preference", async () => {
    const { preference } = await upsertPreference(t.db, alice.id, { category: "general", preferenceKey: "tone", preferenceValue: { value: "formal" }, source: "user_entered" });
    await expect(patchPreference(t.db, bob.id, preference.id, { enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deletePreference(t.db, bob.id, preference.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listPreferences(t.db, bob.id)).length).toBe(0);
  });

  it("a user cannot see or rate another user's optimisation run", async () => {
    const run = await recordRun(t.db, { userId: alice.id, provider: "mock", modelId: "m", templateVersion: "v", taskCategory: "writing", status: "succeeded", inputChars: 10, latencyMs: 5 });
    expect(await getRun(t.db, bob.id, run.id)).toBeNull();
    await expect(submitFeedback(t.db, bob.id, run.id, { rating: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteFeedback(t.db, bob.id, run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("prompt versioning (FR-009, FR-018)", () => {
  it("numbers versions sequentially with parent links and immutable text", async () => {
    const prompt = await createPrompt(t.db, alice.id, PLANS.free, {
      category: "coding",
      versions: [
        { promptText: "fix bug", provenance: "original" },
        { promptText: "Fix the bug in parse()", provenance: "ai_optimised", changeSummary: ["Named the function"] },
      ],
    });
    expect(prompt.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(prompt.versions[1]?.parentVersionId).toBe(prompt.versions[0]?.id);
    expect(prompt.title).toBe("fix bug"); // derived from the first line

    const v3 = await addVersion(t.db, alice.id, PLANS.free, prompt.id, { promptText: "Fix the bug in parse() and add a test", provenance: "user_edited", parentVersionId: prompt.versions[1]?.id });
    expect(v3.versionNumber).toBe(3);
    expect(v3.tokenEstimate).toBeGreaterThan(0);

    const reloaded = await getPrompt(t.db, alice.id, prompt.id);
    expect(reloaded.versions).toHaveLength(3);
    expect(reloaded.versions[1]?.promptText).toBe("Fix the bug in parse()");
  });

  it("rejects a parent version from another prompt", async () => {
    const a = await createPrompt(t.db, alice.id, PLANS.free, { category: "general", versions: [{ promptText: "a", provenance: "original" }] });
    const b = await createPrompt(t.db, alice.id, PLANS.free, { category: "general", versions: [{ promptText: "b", provenance: "original" }] });
    await expect(addVersion(t.db, alice.id, PLANS.free, a.id, { promptText: "c", provenance: "user_edited", parentVersionId: b.versions[0]?.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces the plan's version limit server-side (FR-013)", async () => {
    const tinyPlan = { ...PLANS.free, maxVersionsPerPrompt: 2 };
    const prompt = await createPrompt(t.db, alice.id, tinyPlan, { category: "general", versions: [{ promptText: "one", provenance: "original" }, { promptText: "two", provenance: "ai_optimised" }] });
    await expect(addVersion(t.db, alice.id, tinyPlan, prompt.id, { promptText: "three", provenance: "user_edited" })).rejects.toBeInstanceOf(AppError);
  });

  it("enforces the saved-prompt limit", async () => {
    const carol = await createUser(t.db, "carol");
    const onePlan = { ...PLANS.free, maxSavedPrompts: 1 };
    await createPrompt(t.db, carol.id, onePlan, { category: "general", versions: [{ promptText: "first", provenance: "original" }] });
    await expect(createPrompt(t.db, carol.id, onePlan, { category: "general", versions: [{ promptText: "second", provenance: "original" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("searches titles and version text with pagination", async () => {
    const dave = await createUser(t.db, "dave");
    await createPrompt(t.db, dave.id, PLANS.free, { title: "Quarterly summary", category: "summarisation", tags: ["Finance", "q3"], versions: [{ promptText: "Summarise the quarterly numbers for the board", provenance: "original" }] });
    await createPrompt(t.db, dave.id, PLANS.free, { title: "Regex help", category: "coding", versions: [{ promptText: "Write a regex that matches UK postcodes", provenance: "original" }] });

    expect((await listPrompts(t.db, dave.id, { search: "postcodes" })).items.map((p) => p.title)).toEqual(["Regex help"]);
    expect((await listPrompts(t.db, dave.id, { search: "quarterly" })).items.map((p) => p.title)).toEqual(["Quarterly summary"]);
    expect((await listPrompts(t.db, dave.id, { tag: "finance" })).total).toBe(1);
    expect((await listPrompts(t.db, dave.id, { category: "coding" })).total).toBe(1);
    const page = await listPrompts(t.db, dave.id, { page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it("hides archived prompts unless asked", async () => {
    const erin = await createUser(t.db, "erin");
    const prompt = await createPrompt(t.db, erin.id, PLANS.free, { category: "general", versions: [{ promptText: "archive me", provenance: "original" }] });
    await updatePrompt(t.db, erin.id, prompt.id, { archived: true });
    expect((await listPrompts(t.db, erin.id)).total).toBe(0);
    expect((await listPrompts(t.db, erin.id, { includeArchived: true })).total).toBe(1);
  });
});

describe("feedback (FR-011, FR-021)", () => {
  it("stores one record per run, supports deliberate replace and withdrawal", async () => {
    const run = await recordRun(t.db, { userId: alice.id, provider: "mock", modelId: "m", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 1, latencyMs: 1 });
    const first = await submitFeedback(t.db, alice.id, run.id, { rating: 1, reasonCode: "CLEARER" });
    expect(first.created).toBe(true);
    await expect(submitFeedback(t.db, alice.id, run.id, { rating: -1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await submitFeedback(t.db, alice.id, run.id, { rating: -1, replace: true, comment: "lost the deadline" });
    expect(second.created).toBe(false);
    expect(second.feedback.id).toBe(first.feedback.id);
    expect(second.feedback.rating).toBe(-1);
    await deleteFeedback(t.db, alice.id, run.id);
    await expect(deleteFeedback(t.db, alice.id, run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
