// @vitest-environment node
import { describe, expect, it } from "vitest";

import { assessBreakdown, ensureCoverage, fromModel, PLACEHOLDER, planToMarkdown, ruleBreakdown, stepLevels } from "@/lib/intelligence/breakdown";
import { classifyByRules } from "@/lib/intelligence/classifier";
import { breakdownText } from "@/lib/intelligence/engine";
import { extractRequirements } from "@/lib/intelligence/requirements";
import { validateModelBreakdown, type ModelBreakdown } from "@/lib/intelligence/schemas";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { ProviderError, type IntelligenceProvider } from "@/lib/providers/types";

const BAKERY = `I run a small bakery in Pune called Sweet Crumbs. We sell custom cakes and want more online orders.
Write a 600-word blog post about choosing a birthday cake, then create 5 Instagram captions promoting the post, and draft a short email to our newsletter subscribers announcing it.
Use a warm, friendly tone. Don't mention competitors. Include our website sweetcrumbs.in in every piece.`;
const SHOP = "Build an ecommerce website for my bakery using Next.js and Stripe. Customers should be able to browse cakes, customise the message, pay online and choose a delivery slot. Admins need to manage orders. Keep it mobile-first and accessible.";
const HAIKU = "Write a haiku about rain falling on the old city at night.";

const plan = (text: string) => {
  const reqs = extractRequirements(text);
  const c = classifyByRules(text);
  return { reqs, c, plan: ruleBreakdown(text, reqs, c) };
};
const mock = new MockOptimiserProvider();
const base = { targetModel: "gpt-5-mini", preferences: {}, requestId: "t", userKey: "u" };

describe("rule-based breakdown: several deliverables", () => {
  const { plan: p, reqs, c } = plan(BAKERY);

  it("gives each deliverable its own step plus a final check", () => {
    expect(p.strategy).toBe("deliverables");
    expect(p.steps.map((s) => s.title)).toEqual(["Write a 600-word blog post", "Create 5 Instagram captions", "Draft a short email", "Check everything against your requirements"]);
    expect(p.steps[3]!.is_review).toBe(true);
    expect(p.title).toBe("Write a 600-word blog post, create 5 Instagram captions and draft a short email");
  });

  it("repeats the background and the rules that apply to every piece in each step", () => {
    for (const s of p.steps.slice(0, 3)) {
      expect(s.prompt).toContain("I run a small bakery in Pune called Sweet Crumbs.");
      expect(s.prompt).toContain("Use a warm, friendly tone.");
      expect(s.prompt).toContain("Don't mention competitors.");
      expect(s.prompt).toContain("sweetcrumbs.in");
      expect(s.prompt).toMatch(/Only do this part\./);
    }
    expect(p.shared_context).toContain("Sweet Crumbs");
  });

  it("links steps that build on an earlier result, with the exact placeholder", () => {
    // "promoting the post" and "announcing it" both use the blog post.
    expect(p.steps.map((s) => s.depends_on)).toEqual([[], [1], [1], [1, 2, 3]]);
    expect(p.steps[1]!.prompt).toContain(PLACEHOLDER(1));
    expect(p.steps[3]!.prompt).toContain(PLACEHOLDER(3));
    expect([...stepLevels(p.steps).values()]).toEqual([1, 2, 2, 3]);
    expect(p.run_mode).toBe("same_chat");
  });

  it("explains how to run the sequence", () => {
    expect(p.usage_advice[0]).toBe("Run the steps in this order: 1 → (2 + 3) → 4. Steps 2 and 3 don't depend on each other, so run them in any order or at the same time.");
    expect(p.usage_advice.join(" ")).toMatch(/\[Paste the output of step N here\]/);
    expect(p.usage_advice.join(" ")).toMatch(/Get step 1 right/);
  });

  it("recommends splitting and carries every requirement", async () => {
    expect(assessBreakdown(BAKERY, reqs, c)).toMatchObject({ level: "recommended", deliverables: expect.arrayContaining([expect.stringMatching(/^Write a 600-word blog post/)]) });
    const coverage = await ensureCoverage(BAKERY, p, reqs);
    expect(coverage.every((x) => x.status === "covered")).toBe(true);
    expect(coverage.find((x) => x.text.startsWith("Use a warm"))!.steps).toEqual([1, 2, 3]);
  });

  it("keeps independent deliverables independent", () => {
    const text = "Write a product description for our new hiking boots. Create a comparison table of three tents under $300. Draft a returns policy for our store.";
    const r = plan(text).plan;
    expect(r.steps.filter((s) => !s.is_review).every((s) => s.depends_on.length === 0)).toBe(true);
    expect(r.run_mode).toBe("new_chats");
  });

  it("follows 'then turn it into' to the previous step", () => {
    const r = plan("Summarise the attached meeting notes into key decisions. Then turn it into an email to the team. Then create a task list from the email.").plan;
    expect(r.steps.slice(0, 3).map((s) => s.depends_on)).toEqual([[], [1], [2]]);
  });

  it("caps the number of steps", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Write paragraph ${i + 1} about topic number ${i + 1}.`).join(" ");
    expect(plan(text).plan.steps.length).toBeLessThanOrEqual(8);
  });
});

describe("rule-based breakdown: one big deliverable", () => {
  it("splits a software build into design → implement → test, restating the goal", () => {
    const { plan: p, reqs, c } = plan(SHOP);
    expect(p.strategy).toBe("stages");
    expect(p.steps.map((s) => s.title)).toEqual(["Agree on the approach", "Implement it", "Test and review"]);
    expect(p.steps[0]!.prompt).toContain(SHOP);
    expect(p.steps[1]!.prompt).toContain("Goal: Build an ecommerce website for my bakery using Next.js and Stripe.");
    expect(p.steps[1]!.prompt).toContain("Keep it mobile-first and accessible.");
    expect(p.steps.map((s) => s.depends_on)).toEqual([[], [1], [2]]);
    expect(assessBreakdown(SHOP, reqs, c).level).toBe("optional");
  });

  it("uses options → refine for a short prompt and says one prompt is fine", () => {
    const { plan: p, reqs, c } = plan(HAIKU);
    expect(p.steps.map((s) => s.title)).toEqual(["Get a few options", "Refine your favourite"]);
    expect(p.steps[1]!.prompt).toContain(`Goal: ${HAIKU}`);
    expect(assessBreakdown(HAIKU, reqs, c)).toMatchObject({ level: "single", reasons: ["It has one clear deliverable and few requirements."] });
  });
});

describe("model plans", () => {
  const reqs = extractRequirements(BAKERY);
  const model: ModelBreakdown = {
    title: "Launch content",
    shared_context: "We are Sweet Crumbs, a bakery in Pune.",
    run_mode: "same_chat",
    steps: [
      { title: "Blog post", goal: "Write the post.", prompt: "Write a 600-word blog post about choosing a birthday cake.", depends_on: [], expected_output: "A post", how_to_use: "Start here.", checks: ["600 words"], requirement_ids: [reqs[1]!.id] },
      { title: "Captions", goal: "Promote it.", prompt: "Create 5 Instagram captions promoting this post: [Paste the output of step 1 here]", depends_on: [], expected_output: "5 captions", how_to_use: "", checks: [], requirement_ids: ["made-up"] },
      { title: "Email", goal: "Announce it.", prompt: "Draft a short email announcing the post.\n\n[Paste the outline from step 1 here]", depends_on: [3, 0], expected_output: "", how_to_use: "", checks: [], requirement_ids: [] },
    ],
    usage_advice: ["Run them in order."],
  };

  it("validates dependencies and lengths", () => {
    const v = validateModelBreakdown(model);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.steps[2]!.depends_on).toEqual([]);
    expect(validateModelBreakdown({ ...model, steps: model.steps.slice(0, 1) })).toMatchObject({ ok: false });
    expect(validateModelBreakdown({ ...model, steps: Array.from({ length: 9 }, () => model.steps[0]) })).toMatchObject({ ok: false });
  });

  it("normalises placeholders, adds missing dependencies and context, and re-adds dropped requirements", async () => {
    const v = validateModelBreakdown(model);
    if (!v.ok) throw new Error(v.reason);
    const p = fromModel(v.value, reqs, "writing_communication");
    expect(p.steps[1]!.depends_on).toEqual([1]);
    expect(p.steps[2]!.prompt).toContain(PLACEHOLDER(1));
    expect(p.steps[2]!.depends_on).toEqual([1]);
    expect(p.steps[0]!.prompt.startsWith("Context:\nWe are Sweet Crumbs")).toBe(true);
    expect(p.steps[1]!.requirement_ids).toEqual([]);
    expect(p.usage_advice[0]).toBe("Run them in order.");

    const coverage = await ensureCoverage(BAKERY, p, reqs);
    const added = coverage.filter((c) => c.status === "added").map((c) => c.text);
    expect(added).toEqual(expect.arrayContaining(["Don't mention competitors.", "Include our website sweetcrumbs.in in every piece."]));
    // Rules that apply everywhere are added to every step, not just one.
    for (const s of p.steps) expect(s.prompt.split("Also make sure:")[1]).toContain("- Don't mention competitors.");
    expect(coverage.find((c) => c.text === "Don't mention competitors.")!.steps).toEqual([1, 2, 3]);
  });

  it("produces Markdown with every step", () => {
    const { plan: p } = plan(BAKERY);
    const md = planToMarkdown(p);
    expect(md).toContain("## Step 4: Check everything against your requirements");
    expect(md).toContain("- [ ] Meets: Don't mention competitors.");
  });
});

describe("breakdownText (engine)", () => {
  it("uses the rule-based plan for the rule-based provider", async () => {
    const r = await breakdownText({ ...base, text: BAKERY, classification: classifyByRules(BAKERY), provider: mock });
    expect(r.engine).toBe("rules");
    expect(r.fallback_reason).toBeNull();
    expect(r.plan.steps).toHaveLength(4);
    expect(r.tokens.steps).toHaveLength(4);
    expect(r.tokens.total).toBeGreaterThan(r.tokens.original);
  });

  const fake = (breakdownPrompt: IntelligenceProvider["breakdownPrompt"]): IntelligenceProvider => ({
    name: "open",
    modelId: "qwen",
    analyseIntent: mock.analyseIntent.bind(mock),
    revisePrompt: mock.revisePrompt.bind(mock),
    compareRequirements: mock.compareRequirements.bind(mock),
    breakdownPrompt,
  });
  const attempt = { attempt: 1, status: "ok" as const, modelId: "qwen", usage: { inputTokens: 900, outputTokens: 400, totalTokens: 1300, cachedInputTokens: null } };

  it("uses a model plan when the model answers", async () => {
    const r = await breakdownText({
      ...base,
      text: SHOP,
      classification: classifyByRules(SHOP),
      provider: fake(async () => ({ kind: "ok", modelId: "qwen", attempts: [attempt], output: { title: "Shop", shared_context: null, run_mode: "same_chat", usage_advice: ["Go step by step."], steps: [{ title: "Design", goal: "", prompt: SHOP, depends_on: [], expected_output: "", how_to_use: "", checks: [], requirement_ids: [] }, { title: "Build", goal: "", prompt: "Build it from [Paste the output of step 1 here].", depends_on: [1], expected_output: "", how_to_use: "", checks: [], requirement_ids: [] }] } })),
    });
    expect(r.engine).toBe("model");
    expect(r.plan.title).toBe("Shop");
    expect(r.attempts).toHaveLength(1);
  });

  it("falls back to rules when the model output is unusable or the service is down", async () => {
    const invalid = await breakdownText({ ...base, text: BAKERY, classification: classifyByRules(BAKERY), provider: fake(async () => ({ kind: "invalid_output", reason: "bad", modelId: "qwen", attempts: [{ ...attempt, status: "invalid_output" }] })) });
    expect(invalid).toMatchObject({ engine: "rules", fallback_reason: expect.stringMatching(/couldn't be used/) });
    expect(invalid.attempts).toHaveLength(1);
    const down = await breakdownText({ ...base, text: BAKERY, classification: classifyByRules(BAKERY), provider: fake(async () => { throw new ProviderError("PROVIDER_UNAVAILABLE", "connection_error", { attempts: [{ ...attempt, status: "error", usage: null }] }); }) });
    expect(down).toMatchObject({ engine: "rules", fallback_reason: expect.stringMatching(/unavailable/) });
    expect(down.attempts).toHaveLength(1);
  });

  it("surfaces a refusal", async () => {
    await expect(breakdownText({ ...base, text: BAKERY, classification: classifyByRules(BAKERY), provider: fake(async () => ({ kind: "refused", reason: "no", modelId: "qwen", attempts: [attempt] })) })).rejects.toMatchObject({ kind: "refused" });
  });
});
