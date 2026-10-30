import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/lib/auth/session";
import { MAX_TOKEN_COUNT_CHARS } from "@/lib/config/estimates";
import type { AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

/**
 * Route-level tests: the real handlers, validation, rate limiting and services
 * against an embedded PostgreSQL. Only the session lookup and the database
 * handle are swapped for test doubles.
 */
const holder = vi.hoisted(() => ({ db: null as unknown as Db, users: new Map<string, CurrentUser>() }));

vi.mock("@/lib/db/client", () => ({
  db: new Proxy({} as object, {
    get(_target, key) {
      const value = (holder.db as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.db) : value;
    },
  }),
  pool: {},
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUserFromHeaders: async (headers: Headers) => holder.users.get(headers.get("x-test-user") ?? "") ?? null,
  getCurrentUser: async () => null,
}));

const { POST: estimatePOST } = await import("@/app/api/v1/token-estimates/route");
const { GET: usageRecordsGET } = await import("@/app/api/v1/usage/records/route");
const { GET: modelsGET } = await import("@/app/api/v1/models/route");
const { resetRateLimits } = await import("@/lib/api/rate-limit");
const { recordApiUsage } = await import("@/lib/services/estimates");
const { recordRun } = await import("@/lib/services/usage");

let t: TestDb;
let alice: AppUser;
let bob: AppUser;

function asCurrent(user: AppUser): CurrentUser {
  return { ...user, isAdmin: false, session: { id: "s", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), isFresh: true } };
}

const params = { params: Promise.resolve({}) };

function post(body: unknown, user: string | null = "alice", ip = "10.0.0.1") {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (user) headers["x-test-user"] = user;
  return estimatePOST(new NextRequest("http://localhost:3000/api/v1/token-estimates", { method: "POST", headers, body: JSON.stringify(body) }), params);
}

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  alice = await createUser(t.db, "api-alice");
  bob = await createUser(t.db, "api-bob");
  holder.users.set("alice", asCurrent(alice));
  holder.users.set("bob", asCurrent(bob));
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => resetRateLimits());

describe("POST /api/v1/token-estimates", () => {
  it("requires authentication", async () => {
    const res = await post({ model: "gpt-4o", text: "hi" }, null);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("counts text and labels it as an estimate", async () => {
    const res = await post({ model: "gpt-4o", text: "tiktoken is great!" });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ model: "gpt-4o", token_count: 6, character_count: 18, encoding: "o200k_base", count_type: "text_token_estimate" });
    expect(data.cost.pricing_version).toBe("openai:gpt-4o:2026-10-30");
    expect(data.limitations).toMatch(/system instructions/);
  });

  it("compares original and optimised text", async () => {
    const res = await post({ model: "gpt-4o", original_text: "Write an email.", optimised_text: "Write a short, polite email about invoice 4471.", expected_output: "long" });
    const { data } = await res.json();
    expect(data.tokens_saved).toBeLessThan(0);
    expect(data.cost.expected_output_tokens).toBe(1500);
  });

  it("rejects unsupported models with 422", async () => {
    const res = await post({ model: "gpt-9", text: "hi" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("UNSUPPORTED_MODEL");
  });

  it("rejects oversized text with 413", async () => {
    const res = await post({ model: "gpt-4o", text: "a".repeat(MAX_TOKEN_COUNT_CHARS + 1) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PROMPT_TOO_LONG");
  });

  it("rejects malformed bodies", async () => {
    expect((await post({ model: "gpt-4o" })).status).toBe(400);
    expect((await post({ model: "gpt-4o", text: "a", original_text: "b", optimised_text: "c" })).status).toBe(400);
    expect((await post({ model: "gpt-4o", text: "a", expected_output: "enormous" })).status).toBe(400);
  });

  it("rate limits rapid counting per user", async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await post({ model: "gpt-4o", text: `n${i}` }, "alice", `10.1.0.${i % 200}`)).status;
    expect(last).toBe(429);
    // Another user is unaffected.
    expect((await post({ model: "gpt-4o", text: "ok" }, "bob", "10.2.0.1")).status).toBe(200);
  });

  it("stores nothing unless asked, and stores the final count when asked", async () => {
    const before = await t.db.query.tokenEstimates.findMany();
    await post({ model: "gpt-4o", text: "typing…" });
    expect((await t.db.query.tokenEstimates.findMany()).length).toBe(before.length);

    const res = await post({ model: "gpt-4o", text: "Final prompt.", record: { label: "final" } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recorded).toMatchObject({ label: "final", model: "gpt-4o", token_count: data.token_count });
  });

  it("refuses to link an estimate to another user's optimisation", async () => {
    const run = await recordRun(t.db, { userId: alice.id, provider: "mock", modelId: "mock-optimiser", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 1, latencyMs: 1 });
    const res = await post({ model: "gpt-4o", text: "x", record: { label: "final", run_id: run.id } }, "bob", "10.3.0.1");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/usage/records and /api/v1/models", () => {
  it("returns only the caller's own usage records", async () => {
    const run = await recordRun(t.db, { userId: alice.id, provider: "mock", modelId: "mock-optimiser", templateVersion: "v", taskCategory: null, status: "succeeded", inputChars: 1, latencyMs: 1 });
    await recordApiUsage(t.db, { userId: alice.id, runId: run.id, attempt: 1, provider: "mock", modelId: "mock-optimiser", requestType: "prompt_optimisation", status: "ok", inputTokens: 3, outputTokens: 4 });
    const get = (user: string) =>
      usageRecordsGET(new NextRequest("http://localhost:3000/api/v1/usage/records", { headers: { "x-test-user": user, "x-forwarded-for": "10.9.0.1" } }), params);
    const mine = (await (await get("alice")).json()).data;
    const theirs = (await (await get("bob")).json()).data;
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((r: { usage_source: string }) => r.usage_source === "provider")).toBe(true);
    expect(theirs.total).toBe(0);
  });

  it("lists selectable models with pricing or null", async () => {
    const res = await modelsGET(new NextRequest("http://localhost:3000/api/v1/models", { headers: { "x-test-user": "alice" } }), params);
    const { data } = await res.json();
    expect(data.default_model).toBe("gpt-5-mini");
    expect(data.items.find((m: { id: string }) => m.id === "gpt-4o").pricing.pricing_version).toBe("openai:gpt-4o:2026-10-30");
    expect(data.items.find((m: { id: string }) => m.id === "gpt-5.4").pricing).toBeNull();
  });
});
