import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/lib/auth/session";
import { PLANS } from "@/lib/config/plans";
import type { AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

/** Real route handlers for the prompt library; only session and DB handle are doubles. */
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

const promptsRoute = await import("@/app/api/v1/prompts/route");
const promptRoute = await import("@/app/api/v1/prompts/[id]/route");
const analyseRoute = await import("@/app/api/v1/prompts/[id]/analyse/route");
const suggestionsRoute = await import("@/app/api/v1/prompts/[id]/suggestions/route");
const suggestionRoute = await import("@/app/api/v1/suggestions/[id]/route");
const optimiseRoute = await import("@/app/api/v1/prompts/[id]/optimise/route");
const versionsRoute = await import("@/app/api/v1/prompts/[id]/versions/route");
const restoreRoute = await import("@/app/api/v1/prompts/[id]/restore/[versionId]/route");
const duplicateRoute = await import("@/app/api/v1/prompts/[id]/duplicate/route");
const archiveRoute = await import("@/app/api/v1/prompts/[id]/archive/route");
const summaryRoute = await import("@/app/api/v1/dashboard/summary/route");
const prefsRoute = await import("@/app/api/v1/preferences/prompts/route");
const { resetRateLimits } = await import("@/lib/api/rate-limit");
const { createPrompt } = await import("@/lib/services/prompts");

let t: TestDb;
let alice: AppUser;
let bob: AppUser;
let ip = 0;

const current = (u: AppUser): CurrentUser => ({ ...u, isAdmin: false, session: { id: "s", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), isFresh: true } });

function req(method: string, url: string, user: string | null, body?: unknown) {
  const headers: Record<string, string> = { "x-forwarded-for": `10.20.${Math.floor(ip / 200)}.${ip++ % 200}` };
  if (user) headers["x-test-user"] = user;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const p = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
async function json(res: Response) {
  return (await res.json()) as { data: Record<string, unknown> & { items?: Array<Record<string, unknown>> }; error?: { code: string } };
}

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  alice = await createUser(t.db, "routes-alice");
  bob = await createUser(t.db, "routes-bob");
  holder.users.set("alice", current(alice));
  holder.users.set("bob", current(bob));
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => resetRateLimits());

const VERBOSE = "Please could you write some stuff about our launch. Please could you write some stuff about our launch. Make it short but detailed.";

describe("prompt library routes", () => {
  it("runs the full analyse → accept → optimise → save flow over HTTP", async () => {
    const created = await json(await promptsRoute.POST(req("POST", "/api/v1/prompts", "alice", { description: "Launch copy", target_model: "gpt-4o", category: "writing", versions: [{ prompt_text: VERBOSE, provenance: "original" }] }), p({})));
    const id = created.data.id as string;
    expect(created.data).toMatchObject({ description: "Launch copy", target_model: "gpt-4o", current_version_number: 1 });

    const analysed = await analyseRoute.POST(req("POST", `/api/v1/prompts/${id}/analyse`, "alice", {}), p({ id }));
    expect(analysed.status).toBe(201);
    const analysis = (await json(analysed)).data;
    const suggestions = analysis.suggestions as Array<{ id: string; category: string }>;
    expect(suggestions.length).toBeGreaterThan(0);
    expect((await analyseRoute.POST(req("POST", `/api/v1/prompts/${id}/analyse`, "alice", {}), p({ id }))).status).toBe(200); // reused

    const pick = suggestions[0]!;
    const accepted = await suggestionRoute.PATCH(req("PATCH", `/api/v1/suggestions/${pick.id}`, "alice", { status: "accepted" }), p({ id: pick.id }));
    expect((await json(accepted)).data.status).toBe("accepted");

    const proposal = (await json(await optimiseRoute.POST(req("POST", `/api/v1/prompts/${id}/optimise`, "alice", { mode: "token_saver", suggestion_ids: [pick.id] }), p({ id })))).data;
    expect(proposal.optimisation_mode).toBe("token_saver");
    expect((await json(await versionsRoute.GET(req("GET", `/api/v1/prompts/${id}/versions`, "alice"), p({ id })))).data.items).toHaveLength(1);

    const saved = await versionsRoute.POST(req("POST", `/api/v1/prompts/${id}/versions`, "alice", { prompt_text: proposal.optimised_prompt, optimisation_id: proposal.optimisation_id, suggestion_ids: [pick.id] }), p({ id }));
    expect(saved.status).toBe(201);
    expect((await json(saved)).data).toMatchObject({ version_number: 2, provenance: "ai_optimised" });

    const list = (await json(await suggestionsRoute.GET(req("GET", `/api/v1/prompts/${id}/suggestions?status=applied`, "alice"), p({ id })))).data;
    expect(list.items?.map((s) => s.id)).toEqual([pick.id]);

    const v1 = ((await json(await versionsRoute.GET(req("GET", `/api/v1/prompts/${id}/versions`, "alice"), p({ id })))).data.items as Array<{ id: string }>)[0]!;
    expect((await restoreRoute.POST(req("POST", `/api/v1/prompts/${id}/restore/${v1.id}`, "alice"), p({ id, versionId: v1.id }))).status).toBe(201);
    expect((await duplicateRoute.POST(req("POST", `/api/v1/prompts/${id}/duplicate`, "alice"), p({ id }))).status).toBe(201);
    expect((await json(await archiveRoute.PATCH(req("PATCH", `/api/v1/prompts/${id}/archive`, "alice", { archived: true }), p({ id })))).data.archived_at).not.toBeNull();

    const summary = (await json(await summaryRoute.GET(req("GET", "/api/v1/dashboard/summary", "alice"), p({})))).data;
    expect(summary.total_prompts).toBe(1); // original archived, duplicate active
  });

  it("filters and sorts the listing via query parameters", async () => {
    await createPrompt(t.db, alice.id, PLANS.pro, { title: "Fav one", category: "coding", versions: [{ promptText: "a b c", provenance: "original" }] });
    const fav = (await json(await promptsRoute.GET(req("GET", "/api/v1/prompts?search=Fav", "alice"), p({})))).data.items![0]!;
    await promptRoute.PATCH(req("PATCH", `/api/v1/prompts/${fav.id}`, "alice", { is_favourite: true }), p({ id: fav.id as string }));
    const favs = (await json(await promptsRoute.GET(req("GET", "/api/v1/prompts?favourite=true&sort=largest", "alice"), p({})))).data;
    expect(favs.items?.map((i) => i.id)).toEqual([fav.id]);
    expect(favs.items?.[0]?.preview).toBe("a b c");
    expect((await promptsRoute.GET(req("GET", "/api/v1/prompts?sort=bogus", "alice"), p({}))).status).toBe(400);
  });

  it("returns 404 for every cross-user access by ID", async () => {
    const own = await createPrompt(t.db, alice.id, PLANS.pro, { category: "writing", versions: [{ promptText: VERBOSE, provenance: "original" }] });
    const id = own.id;
    const analysis = (await json(await analyseRoute.POST(req("POST", `/api/v1/prompts/${id}/analyse`, "alice", {}), p({ id })))).data;
    const sid = (analysis.suggestions as Array<{ id: string }>)[0]!.id;
    const vid = own.versions[0]!.id;

    const statuses = await Promise.all([
      promptRoute.GET(req("GET", `/api/v1/prompts/${id}`, "bob"), p({ id })),
      analyseRoute.POST(req("POST", `/api/v1/prompts/${id}/analyse`, "bob", {}), p({ id })),
      suggestionsRoute.GET(req("GET", `/api/v1/prompts/${id}/suggestions`, "bob"), p({ id })),
      suggestionRoute.PATCH(req("PATCH", `/api/v1/suggestions/${sid}`, "bob", { status: "dismissed" }), p({ id: sid })),
      optimiseRoute.POST(req("POST", `/api/v1/prompts/${id}/optimise`, "bob", {}), p({ id })),
      versionsRoute.POST(req("POST", `/api/v1/prompts/${id}/versions`, "bob", { prompt_text: "x" }), p({ id })),
      restoreRoute.POST(req("POST", `/api/v1/prompts/${id}/restore/${vid}`, "bob"), p({ id, versionId: vid })),
      duplicateRoute.POST(req("POST", `/api/v1/prompts/${id}/duplicate`, "bob"), p({ id })),
      archiveRoute.PATCH(req("PATCH", `/api/v1/prompts/${id}/archive`, "bob", { archived: true }), p({ id })),
    ]).then((rs) => rs.map((r) => r.status));
    expect(statuses).toEqual(Array(9).fill(404));
    expect((await promptRoute.GET(req("GET", `/api/v1/prompts/${id}`, null), p({ id }))).status).toBe(401);
  });

  it("rate limits analysis requests", async () => {
    const own = await createPrompt(t.db, bob.id, PLANS.pro, { category: "writing", versions: [{ promptText: VERBOSE, provenance: "original" }] });
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await analyseRoute.POST(req("POST", `/api/v1/prompts/${own.id}/analyse`, "bob", {}), p({ id: own.id }))).status;
    expect(last).toBe(429);
  });

  it("validates and saves prompt preferences", async () => {
    const bad = await prefsRoute.PATCH(req("PATCH", "/api/v1/preferences/prompts", "alice", { preferred_model: "gpt-9" }), p({}));
    expect(bad.status).toBe(422);
    const ok = await prefsRoute.PATCH(req("PATCH", "/api/v1/preferences/prompts", "alice", { token_efficiency_priority: "high", domains: ["sales emails", " ", "sales emails"] }), p({}));
    expect((await json(ok)).data).toMatchObject({ token_efficiency_priority: "high", domains: ["sales emails"], auto_save_enabled: true });
    const read = (await json(await prefsRoute.GET(req("GET", "/api/v1/preferences/prompts", "alice"), p({})))).data;
    expect(read.feedback_history).toBeTypeOf("object");
  });
});
