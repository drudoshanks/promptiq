import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import seed from "../../db/seed/prompt-library.json";
import type { CurrentUser } from "@/lib/auth/session";
import { promptTemplates, type AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

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

const { syncPromptLibrary, searchTemplates, getTemplate, relatedTemplates, saveTemplateToMyPrompts, recordTemplateUse } = await import("@/lib/services/prompt-library");
const { getPrompt } = await import("@/lib/services/prompts");
const listRoute = await import("@/app/api/v1/prompt-library/route");
const detailRoute = await import("@/app/api/v1/prompt-library/[slug]/route");
const useRoute = await import("@/app/api/v1/prompt-library/[slug]/use/route");
const saveRoute = await import("@/app/api/v1/prompt-library/[slug]/save/route");
const { resetRateLimits } = await import("@/lib/api/rate-limit");

type Item = Parameters<typeof syncPromptLibrary>[1][number];
const items = seed as Item[];

let t: TestDb;
let user: AppUser;
let ip = 0;
const current = (u: AppUser): CurrentUser => ({ ...u, isAdmin: false, session: { id: "s", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), isFresh: true } });
function req(url: string, init: { method?: string; body?: unknown; user?: string } = {}) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: init.method ?? "GET",
    headers: { "x-forwarded-for": `10.80.${Math.floor(ip / 200)}.${ip++ % 200}`, origin: "http://localhost:3000", "content-type": "application/json", ...(init.user === undefined ? { "x-test-user": "reader" } : init.user ? { "x-test-user": init.user } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  user = await createUser(t.db, "library-reader");
  holder.users.set("reader", current(user));
  await syncPromptLibrary(t.db, items);
});
afterAll(async () => t.close());
beforeEach(() => resetRateLimits());

describe("syncing the seed", () => {
  it("is idempotent, updates changed entries, hides removed ones and keeps use counts", async () => {
    expect(await syncPromptLibrary(t.db, items)).toEqual({ inserted: 0, updated: 0, hidden: 0, unchanged: items.length });

    await recordTemplateUse(t.db, "code-review");
    const changed = items.map((i) => (i.slug === "code-review" ? { ...i, title: "Review my code" } : i)).filter((i) => i.slug !== "trip-itinerary");
    expect(await syncPromptLibrary(t.db, changed)).toMatchObject({ inserted: 0, updated: 1, hidden: 1 });
    const row = await getTemplate(t.db, "code-review");
    expect(row.title).toBe("Review my code");
    expect(row.useCount).toBe(1);
    await expect(getTemplate(t.db, "trip-itinerary")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Restored when it comes back.
    expect(await syncPromptLibrary(t.db, items)).toMatchObject({ inserted: 0, updated: 2, hidden: 0 });
    expect((await getTemplate(t.db, "trip-itinerary")).isActive).toBe(true);
  });

  it("rejects bad seeds", async () => {
    await expect(syncPromptLibrary(t.db, [items[0]!, items[0]!])).rejects.toThrow(/Duplicate/);
    await expect(syncPromptLibrary(t.db, [{ ...items[0]!, category: "nope" }])).rejects.toThrow(/Unknown/);
  });

  it("stores the blanks of each prompt", async () => {
    const row = await t.db.query.promptTemplates.findFirst({ where: eq(promptTemplates.slug, "cold-outreach-email") });
    expect(row?.variables.length).toBeGreaterThan(0);
  });
});

describe("search", () => {
  it("finds prompts by words, title substrings and tags", async () => {
    const cold = await searchTemplates(t.db, { q: "cold email" });
    expect(cold.items[0]?.slug).toBe("cold-outreach-email");
    expect((await searchTemplates(t.db, { q: "regex" })).items.length).toBeGreaterThan(0);
    expect((await searchTemplates(t.db, { q: "SEO" })).items.length).toBeGreaterThan(0);
    expect((await searchTemplates(t.db, { q: "zzzqqq nothing" })).total).toBe(0);
    // Punctuation is safe.
    expect((await searchTemplates(t.db, { q: `"%_\\' OR 1=1 --` })).total).toBeGreaterThanOrEqual(0);
  });

  it("filters by category, counts categories and pages", async () => {
    const all = await searchTemplates(t.db, {});
    expect(all.all_count).toBe(items.length);
    expect(all.sort).toBe("popular");
    const coding = await searchTemplates(t.db, { category: "coding", pageSize: 10 });
    expect(coding.items.every((i) => i.category === "coding")).toBe(true);
    expect(coding.total).toBe(all.categories.find((c) => c.id === "coding")!.count);
    const page2 = await searchTemplates(t.db, { category: "coding", pageSize: 10, page: 2 });
    expect(page2.items.map((i) => i.slug)).not.toContain(coding.items[0]!.slug);
    const az = await searchTemplates(t.db, { sort: "az", pageSize: 5 });
    const lower = az.items.map((i) => i.title.toLowerCase());
    expect(lower).toEqual([...lower].sort());
  });

  it("lists related prompts from the same category", async () => {
    const related = await relatedTemplates(t.db, await getTemplate(t.db, "debug-an-error"));
    expect(related.length).toBe(4);
    expect(related.every((r) => r.category === "coding" && r.slug !== "debug-an-error")).toBe(true);
  });
});

describe("saving to My prompts", () => {
  it("copies the prompt with filled blanks as the user's own", async () => {
    const before = (await getTemplate(t.db, "cold-outreach-email")).useCount;
    const template = await getTemplate(t.db, "cold-outreach-email");
    const first = template.variables[0]!;
    const saved = await saveTemplateToMyPrompts(t.db, user, "cold-outreach-email", { [first]: "Priya at Acme" });
    const prompt = await getPrompt(t.db, user.id, saved.prompt_id);
    expect(prompt.tags).toEqual(["library", "marketing"].includes(template.category) ? ["library", template.category] : ["library", template.category.replace(/_/g, "-")]);
    const version = prompt.versions[0]!;
    expect(version.provenance).toBe("imported");
    expect(version.promptText).toContain("Priya at Acme");
    expect(version.promptText).not.toContain(`{{${first}}}`);
    expect((await getTemplate(t.db, "cold-outreach-email")).useCount).toBe(before + 1);
  });
});

describe("routes", () => {
  it("need a signed-in user", async () => {
    const res = await listRoute.GET(req("/api/v1/prompt-library", { user: "" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("search, show, count a use and save", async () => {
    const list = await listRoute.GET(req("/api/v1/prompt-library?q=interview&category=career"), { params: Promise.resolve({}) });
    expect(list.status).toBe(200);
    const { data: body } = (await list.json()) as { data: { items: Array<{ slug: string; category: string }>; total: number } };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((i) => i.category === "career")).toBe(true);

    expect((await listRoute.GET(req("/api/v1/prompt-library?category=weapons"), { params: Promise.resolve({}) })).status).toBe(400);

    const detail = await detailRoute.GET(req("/api/v1/prompt-library/support-reply"), slugParams("support-reply"));
    expect(detail.status).toBe(200);
    const { data: d } = (await detail.json()) as { data: { prompt_text: string; related: unknown[]; license: string } };
    expect(d.prompt_text.length).toBeGreaterThan(100);
    expect(d.related.length).toBeGreaterThan(0);
    expect((await detailRoute.GET(req("/api/v1/prompt-library/no-such-prompt"), slugParams("no-such-prompt"))).status).toBe(404);
    expect((await detailRoute.GET(req("/api/v1/prompt-library/BAD_slug"), slugParams("BAD_slug"))).status).toBe(400);

    const before = (await getTemplate(t.db, "support-reply")).useCount;
    expect((await useRoute.POST(req("/api/v1/prompt-library/support-reply/use", { method: "POST" }), slugParams("support-reply"))).status).toBe(204);
    expect((await getTemplate(t.db, "support-reply")).useCount).toBe(before + 1);

    const saved = await saveRoute.POST(req("/api/v1/prompt-library/support-reply/save", { method: "POST", body: { values: {} } }), slugParams("support-reply"));
    expect(saved.status).toBe(201);
    expect(((await saved.json()) as { data: { prompt_id: string } }).data.prompt_id).toBeTruthy();
    const bad = await saveRoute.POST(req("/api/v1/prompt-library/support-reply/save", { method: "POST", body: { values: { "{{x}}": "y" } } }), slugParams("support-reply"));
    expect(bad.status).toBe(400);
  });
});
