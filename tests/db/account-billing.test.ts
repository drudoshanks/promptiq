import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLANS } from "@/lib/config/plans";
import { appUsers, authUser, deletionJobs, optimisationRuns } from "@/lib/db/schema";
import { applySubscription, processBillingEvent } from "@/lib/services/billing";
import { requestAccountDeletion } from "@/lib/services/deletion";
import { buildAccountExport } from "@/lib/services/exports";
import { submitFeedback } from "@/lib/services/feedback";
import { upsertPreference } from "@/lib/services/preferences";
import { createPrompt, listPrompts } from "@/lib/services/prompts";
import { getUsageSummary, recordRun, resolveQuotaPeriod } from "@/lib/services/usage";
import { getAdminMetrics } from "@/lib/services/admin";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

function stripeSubscription(overrides: Partial<Stripe.Subscription> & { appUserId: string; periodEnd: number }): Stripe.Subscription {
  const { appUserId, periodEnd, ...rest } = overrides;
  return {
    id: "sub_123",
    object: "subscription",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    metadata: { app_user_id: appUserId },
    items: { object: "list", data: [{ id: "si_1", current_period_start: periodEnd - 30 * 86400, current_period_end: periodEnd } as unknown as Stripe.SubscriptionItem], has_more: false, url: "" },
    ...rest,
  } as unknown as Stripe.Subscription;
}

describe("data export (FR-016)", () => {
  it("contains settings, preferences, prompts with versions and feedback", async () => {
    const user = await createUser(t.db, "export-user");
    await upsertPreference(t.db, user.id, { category: "writing", preferenceKey: "tone", preferenceValue: { value: "formal" }, source: "user_entered" });
    await createPrompt(t.db, user.id, PLANS.free, { category: "writing", versions: [{ promptText: "v1", provenance: "original" }, { promptText: "v2", provenance: "ai_optimised" }] });
    const run = await recordRun(t.db, { userId: user.id, provider: "mock", modelId: "m", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 2, latencyMs: 1 });
    await submitFeedback(t.db, user.id, run.id, { rating: 1 });

    const doc = await buildAccountExport(t.db, user);
    expect(doc.format).toBe("promptiq.account");
    expect(doc.account.email).toBe("export-user@example.com");
    expect(doc.preferences).toHaveLength(1);
    expect(doc.prompts).toHaveLength(1);
    expect(doc.prompts[0]?.versions.map((v) => v.prompt_text)).toEqual(["v1", "v2"]);
    expect(doc.feedback).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain("auth:");
  });
});

describe("account deletion (FR-017, §12.2)", () => {
  it("removes content and credentials, anonymises the profile and keeps audit metadata", async () => {
    const user = await createUser(t.db, "delete-me");
    await t.db.insert(authUser).values({ id: user.authSubject, name: "Delete Me", email: "delete-me@example.com" });
    await upsertPreference(t.db, user.id, { category: "general", preferenceKey: "tone", preferenceValue: { value: "formal" }, source: "user_entered" });
    await createPrompt(t.db, user.id, PLANS.free, { category: "general", versions: [{ promptText: "secret prompt", provenance: "original" }] });
    await recordRun(t.db, { userId: user.id, provider: "mock", modelId: "m", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 13, latencyMs: 1 });

    const job = await requestAccountDeletion(t.db, user.id);
    expect(job.status).toBe("completed");

    const profile = await t.db.query.appUsers.findFirst({ where: eq(appUsers.id, user.id) });
    expect(profile?.deletedAt).not.toBeNull();
    expect(profile?.email).toBeNull();
    expect((await listPrompts(t.db, user.id, { includeArchived: true })).total).toBe(0);
    expect(await t.db.query.authUser.findFirst({ where: eq(authUser.id, user.authSubject) })).toBeUndefined();
    expect((await t.db.query.optimisationRuns.findMany({ where: eq(optimisationRuns.userId, user.id) })).length).toBe(1);
    expect((await t.client.query("SELECT count(*)::int AS n FROM prompt_versions WHERE prompt_text = 'secret prompt'")).rows[0]).toEqual({ n: 0 });

    await expect(requestAccountDeletion(t.db, user.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const jobs = await t.db.query.deletionJobs.findMany({ where: eq(deletionJobs.userId, user.id) });
    expect(jobs).toHaveLength(1);
  });
});

describe("billing (FR-015, §12)", () => {
  it("applies a verified subscription to plan state and uses the billing period for quota", async () => {
    const user = await createUser(t.db, "billing-user");
    const periodEnd = Math.floor(Date.now() / 1000) + 15 * 86400;
    await applySubscription(t.db, user.id, stripeSubscription({ appUserId: user.id, periodEnd }));

    const upgraded = await t.db.query.appUsers.findFirst({ where: eq(appUsers.id, user.id) });
    expect(upgraded?.planCode).toBe("pro");
    const period = await resolveQuotaPeriod(t.db, upgraded!);
    expect(period.source).toBe("billing_period");
    expect(period.end.getTime()).toBe(periodEnd * 1000);
    expect((await getUsageSummary(t.db, upgraded!)).limit).toBe(PLANS.pro.optimisationsPerPeriod);

    await applySubscription(t.db, user.id, stripeSubscription({ appUserId: user.id, periodEnd, status: "canceled" }));
    const downgraded = await t.db.query.appUsers.findFirst({ where: eq(appUsers.id, user.id) });
    expect(downgraded?.planCode).toBe("free");
  });

  it("processes each webhook event once", async () => {
    const user = await createUser(t.db, "webhook-user");
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const event = {
      id: "evt_1",
      type: "customer.subscription.updated",
      data: { object: stripeSubscription({ appUserId: user.id, periodEnd, id: "sub_webhook" }) },
    } as unknown as Stripe.Event;

    expect(await processBillingEvent(t.db, event)).toBe("processed");
    expect(await processBillingEvent(t.db, event)).toBe("duplicate");
    expect(await processBillingEvent(t.db, { ...event, id: "evt_2", type: "invoice.paid" } as unknown as Stripe.Event)).toBe("ignored");
    const profile = await t.db.query.appUsers.findFirst({ where: eq(appUsers.id, user.id) });
    expect(profile?.planCode).toBe("pro");
  });
});

describe("admin metrics (FR-020)", () => {
  it("aggregates without exposing prompt text or emails", async () => {
    const metrics = await getAdminMetrics(t.db);
    expect(metrics.runs.last_7d.total_runs).toBeGreaterThan(0);
    expect(metrics.users.total).toBeGreaterThan(0);
    const serialised = JSON.stringify(metrics);
    expect(serialised).not.toContain("@example.com");
    expect(serialised).not.toContain("secret prompt");
  });
});
