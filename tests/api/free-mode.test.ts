import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/lib/auth/session";
import { FREE_FOR_ALL, PLANS, planFor } from "@/lib/config/plans";
import { usageEvents, type AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

/** Free mode end to end through the real routes; only session and DB handle are doubles. */
const holder = vi.hoisted(() => ({ db: null as unknown as Db, users: new Map<string, CurrentUser>() }));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy({} as object, {
    get(_t, key) {
      const value = (holder.db as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(holder.db) : value;
    },
  }),
  pool: {},
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUserFromHeaders: async (headers: Headers) => holder.users.get(headers.get("x-test-user") ?? "") ?? null,
  getCurrentUser: async () => null,
}));
vi.mock("@/lib/services/payment-context", () => ({
  upiConfig: () => ({ vpa: "promptiq@okaxis", payeeName: "PromptIQ", requestTtlHours: 48 }),
  dispatchNotificationsSoon: () => undefined,
}));

const validateRoute = await import("@/app/api/v1/prompt-intelligence/validate/route");
const optimiseRoute = await import("@/app/api/v1/prompt-intelligence/optimise/route");
const paymentsRoute = await import("@/app/api/v1/billing/payment-requests/route");
const { resetRateLimits, RATE_LIMITS } = await import("@/lib/api/rate-limit");
const { createPrompt, countPrompts } = await import("@/lib/services/prompts");
const { assertAnalysisQuotaAvailable } = await import("@/lib/services/usage");
const { serialiseMe } = await import("@/lib/api/serialisers");

let t: TestDb;
let ip = 0;
const users: Record<string, AppUser> = {};
const current = (u: AppUser): CurrentUser => ({ ...u, isAdmin: false, session: { id: "s", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), isFresh: true } });
function req(url: string, user: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "x-forwarded-for": `10.70.${Math.floor(ip / 200)}.${ip++ % 200}`, origin: "http://localhost:3000", "content-type": "application/json", "x-test-user": user },
    body: JSON.stringify(body),
  });
}
const none = { params: Promise.resolve({}) };
const PROMPT = "Write a short welcome email for new customers of our bakery. Keep it under 120 words and mention the 10% first-order discount.";

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  for (const name of ["heavy", "spender", "collector"]) {
    users[name] = await createUser(t.db, `free-${name}`);
    holder.users.set(name, current(users[name]!));
  }
});
afterAll(async () => t.close());
beforeEach(() => {
  resetRateLimits();
  process.env.FREE_MODE = "true";
});
afterEach(() => {
  process.env.FREE_MODE = "false";
});

describe("free mode", () => {
  it("gives everyone unlimited quotas and library space, and switches off cleanly", () => {
    expect(planFor("free")).toMatchObject({ unlimited: true, priceLabel: "Free", maxPromptChars: 40_000 });
    expect(planFor("pro")).toMatchObject({ code: "pro", unlimited: true });
    expect(serialiseMe(current(users.heavy!)).plan).toMatchObject({ unlimited: true, optimisations_per_period: null, max_saved_prompts: null });
    process.env.FREE_MODE = "false";
    expect(planFor("free")).toEqual(PLANS.free);
    expect(FREE_FOR_ALL.unlimited).toBe(true);
  });

  it("lifts per-user rate limits", async () => {
    const calls = RATE_LIMITS.validatePerMinute.limit + 5;
    for (let i = 0; i < calls; i++) {
      const res = await validateRoute.POST(req("/api/v1/prompt-intelligence/validate", "heavy", { original: PROMPT, revised: PROMPT }), none);
      expect(res.status).toBe(200);
    }
    // With free mode off, the same burst is limited again.
    process.env.FREE_MODE = "false";
    resetRateLimits();
    const statuses: number[] = [];
    for (let i = 0; i < calls; i++) statuses.push((await validateRoute.POST(req("/api/v1/prompt-intelligence/validate", "heavy", { original: PROMPT, revised: PROMPT }), none)).status);
    expect(statuses).toContain(429);
  });

  it("never blocks on monthly quotas", async () => {
    const user = users.spender!;
    for (let i = 0; i < PLANS.free.optimisationsPerPeriod + 5; i++) await t.db.insert(usageEvents).values({ userId: user.id, eventType: "optimisation", units: 1, idempotencyKey: `opt:fill-${i}` });
    for (let i = 0; i < PLANS.free.analysesPerPeriod + 5; i++) await t.db.insert(usageEvents).values({ userId: user.id, eventType: "analysis", units: 1, idempotencyKey: `analysis:fill-${i}` });
    await expect(assertAnalysisQuotaAvailable(t.db, user)).resolves.toBeUndefined();
    const res = await optimiseRoute.POST(req("/api/v1/prompt-intelligence/optimise", "spender", { prompt_text: PROMPT, mode: "balanced" }), none);
    expect(res.status).toBe(201);

    process.env.FREE_MODE = "false";
    const blocked = await optimiseRoute.POST(req("/api/v1/prompt-intelligence/optimise", "spender", { prompt_text: PROMPT, mode: "balanced" }), none);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("QUOTA_EXCEEDED");
  });

  it("has no library cap", async () => {
    const user = users.collector!;
    for (let i = 0; i < PLANS.free.maxSavedPrompts + 3; i++) {
      await createPrompt(t.db, user.id, planFor(user.planCode), { category: "general", versions: [{ promptText: `Prompt number ${i}`, provenance: "original" }] });
    }
    expect(await countPrompts(t.db, user.id)).toBe(PLANS.free.maxSavedPrompts + 3);
  });

  it("refuses new payments: there is nothing to pay for", async () => {
    const res = await paymentsRoute.POST(req("/api/v1/billing/payment-requests", "heavy", { plan_code: "pro_monthly" }), none);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/free right now/);
  });
});
