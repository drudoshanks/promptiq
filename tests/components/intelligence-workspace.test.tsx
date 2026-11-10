// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntelligenceWorkspace } from "@/components/intelligence/workspace";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const PROMPT = "Build an ecommerce website";
const dims = ["objective", "context", "specificity", "constraints", "output_format", "examples"].map((key, i) => ({ key, label: key, weight: 10, normalised_weight: i === 5 ? 0 : 0.2, score: 0.3, applicable: i !== 5, evidence: [`Evidence for ${key}`] }));
const analysis = {
  analysis_id: null,
  prompt_id: null,
  prompt_version_id: null,
  is_current: null,
  stored: false,
  reused: false,
  classification: { primary: "software_development", primary_label: "Software development", secondary: null, secondary_label: null, objective: "Build an ecommerce website", confidence: 0.76, method: "rules", template: { id: "coding", label: "Software development", version: 1 } },
  score: { overall: 24, dimensions: dims, missing_elements: [], priorities: [], sufficiently_clear: false, needs_more_context: true, explanation: "", note: "Heuristic, not a measure of answer quality." },
  missing_information: [{ key: "payment_provider", label: "Payment provider", question: "Which payment provider?" }],
  clarification_questions: [{ key: "payment_provider", label: "Payment provider", question: "Which payment provider?" }],
  assumptions: ["Payment provider: not specified. If it matters, ask before choosing; otherwise state the choice you make."],
  requirements: [],
  model_requirements: [],
  intent: null,
  suggestions: [
    { id: "s_1", category: "output_format", category_label: "Output format", priority: "medium", title: "Say what form the answer should take", explanation: "No format.", recommended_change: "Add the format.", expected_benefit: "Usable output.", estimated_token_impact: null, token_direction: "increase", requires_clarification: false, clarification_question: null, source: "rules", ranking: { score: 0.5, acceptance: 0.5, preference_match: 0.5, task_relevance: 0.7, feedback_events: 0, explanation: "no feedback" }, status: "pending", persisted: false },
    { id: "s_2", category: "redundancy", category_label: "Redundancy", priority: "low", title: "Remove repeated instructions", explanation: "Repeats.", recommended_change: "Keep each once.", expected_benefit: "Shorter.", estimated_token_impact: -6, token_direction: "reduce", requires_clarification: false, clarification_question: null, source: "rules", ranking: { score: 0.5, acceptance: 0.5, preference_match: 0.5, task_relevance: 0.6, feedback_events: 0, explanation: "no feedback" }, status: "pending", persisted: false },
  ],
  already_well_optimised: false,
  breakdown: { level: "recommended", headline: "Splitting this into smaller prompts will likely give you a better result.", reasons: ["It asks for 3 separate things."], deliverables: [] },
  summary: "2 improvements",
  token_estimate: { model: "gpt-5-mini", token_count: 4, cost: null },
  model_used: false,
  template_version: "t",
};
const count = (n: number) => ({ model: "gpt-5-mini", encoding: "o200k_base", token_count: n, character_count: n * 4, count_type: "text_token_estimate", tokenizer_version: "t" });
const revision = {
  revision_id: "11111111-1111-4111-8111-111111111111",
  optimisation_id: "11111111-1111-4111-8111-111111111111",
  prompt_id: null,
  source_version_id: null,
  mode: "balanced",
  engine: "model",
  category: "software_development",
  category_label: "Software development",
  template: { id: "coding", label: "Software development", version: 1 },
  original_prompt: PROMPT,
  revised_prompt: "Build an ecommerce website.\n\nOutput format:\n[Add: format and length]",
  intent: {},
  preservation: { status: "passed", checks: [{ id: "r1", kind: "objective", kind_label: "Objective", text: PROMPT, essential: true, status: "preserved", method: "deterministic", note: null }], preserved: 1, changed: 0, missing: 0, contradicted: 0, new_assumptions: [], contradictions: [], summary: "All 1 detected requirement was found in the revision.", disclaimer: "Cannot guarantee." },
  key_improvements: ["Applied 1 accepted suggestion."],
  assumptions_introduced: [],
  clarification_questions: [],
  iterations: 1,
  repaired: false,
  compression_steps: [],
  budget: { requested: null, met: true, explanation: null, alternatives: [] },
  estimate: { model: "gpt-5-mini", encoding: "o200k_base", tokenizer_version: "t", original: count(4), optimised: count(14), tokens_saved: -10, reduction_percent: -250, is_smaller: false, cost: { input_cost_difference: -0.0000025 }, pricing_warning: null, limitations: "" },
  actual_usage: {},
  suggestion_ids: [],
  template_version: "t",
  preferences_applied: { effective: { tone: "friendly" }, skipped_because_prompt_says_otherwise: ["format"], personalisation_enabled: true },
  auto_saved: null as null | { prompt_id: string; original_version_id: string; proposed_version_id: string },
  auto_save_skipped: null,
};
let nextRevision = revision;

const step = (number: number, title: string, prompt: string, depends_on: number[], extra: Record<string, unknown> = {}) => ({ number, title, goal: `Goal ${number}`, prompt, depends_on, parallel_with: [], expected_output: `Output ${number}`, how_to_use: number === 1 ? "Start here." : `Run after step ${depends_on.join(" and ")}.`, checks: [`Check ${number}`], requirement_ids: ["r1"], is_review: false, tokens: 40 + number, ...extra });
const breakdownFixture = {
  breakdown_id: "22222222-2222-4222-8222-222222222222",
  prompt_id: null,
  prompt_version_id: null,
  title: "Write a blog post and create captions",
  strategy: "deliverables",
  engine: "rules",
  fallback_reason: null,
  category: "writing_communication",
  category_label: "Writing and communication",
  assessment: { level: "recommended", headline: "Splitting this into smaller prompts will likely give you a better result.", reasons: ["It asks for 2 separate things."], deliverables: [] },
  shared_context: null,
  run_mode: "same_chat",
  steps: [
    step(1, "Write a blog post", "Write a blog post about cakes.", []),
    { ...step(2, "Create captions", "Create 3 captions for the post.\n\n[Paste the output of step 1 here]", [1]), parallel_with: [] },
    step(3, "Check everything against your requirements", "Check it.", [1, 2], { is_review: true }),
  ],
  usage_advice: ["Run the steps in this order: 1 → 2 → 3.", "Read each answer before moving on."],
  coverage: { total: 1, covered: 1, added: 0, items: [{ id: "r1", text: "Write a blog post about cakes.", kind: "objective", kind_label: "Objective", steps: [1], status: "covered" }], summary: "All 1 requirement is carried by at least one step." },
  tokens: { model: "gpt-5-mini", original: 20, steps_total: 129 },
  usage: null,
};

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status, headers: { "content-type": "application/json" } });
let failNext = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  if (failNext) {
    failNext = false;
    return json({ error: { code: "QUOTA_EXCEEDED", message: "You have used all 30 prompt analyses for this period." } }, 429);
  }
  if (url.endsWith("/analyse")) return json(analysis, 201);
  if (url.endsWith("/breakdown/save")) return json({ tag: "steps-write-a-blog-post", prompts: [{ id: "a" }, { id: "b" }, { id: "c" }], library_url: "/app/library?tag=steps-write-a-blog-post" }, 201);
  if (url.endsWith("/breakdown")) return json(breakdownFixture);
  if (url.endsWith("/optimise") || url.endsWith("/generate")) return json(nextRevision, 201);
  if (url.endsWith("/token-estimates")) return json({ model: "gpt-5-mini", token_count: 4, character_count: 26, cost: null });
  if (url.endsWith("/validate")) return json({ preservation: { ...revision.preservation, status: "failed", summary: "1 essential requirement is missing or reversed." }, estimate: { ...revision.estimate, optimised: count(2) } });
  if (url === "/api/v1/prompts") return json({ id: "p-new" }, 201);
  return json({ recorded: true }, 201);
});

beforeEach(() => {
  calls.length = 0;
  nextRevision = revision;
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no <dialog> modal API.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  render(<IntelligenceWorkspace models={[{ id: "gpt-5-mini", label: "GPT-5 mini" }]} defaultModel="gpt-5-mini" defaultMode="balanced" />);
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: PROMPT } });
}

describe("Prompt intelligence workspace", () => {
  it("analyses, shows the rubric, suggestions and missing information", async () => {
    setup();
    expect(screen.getByText("Start with an analysis")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Analyse prompt/ }));
    expect(await screen.findByText("Completeness score")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Software development/ })).toBeTruthy();
    expect(screen.getByText("Say what form the answer should take")).toBeTruthy();
    expect(screen.getByText("-6 tokens")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Payment provider" })).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: "/api/v1/prompt-intelligence/analyse", body: { prompt_text: PROMPT, category: null, target_model: "gpt-5-mini" } });
  });

  it("applies selected suggestions and answers, then shows an honest comparison", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Analyse prompt/ }));
    await screen.findByText("Completeness score");
    const apply = screen.getByRole("button", { name: /Apply/ });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Say what form/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Payment provider" }), { target: { value: "Stripe" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply 1 selected/ }));
    expect(await screen.findByText("Proposed prompt")).toBeTruthy();
    const sent = calls.find((c) => c.url.endsWith("/optimise"))!;
    expect(sent.body).toMatchObject({ mode: "balanced", accepted_changes: [{ category: "output_format", text: "Add the format." }], answers: { payment_provider: "Stripe" } });
    expect(sent.body.assumptions).toEqual([]); // the answered question's assumption is dropped
    expect(screen.getByText("Tokens added")).toBeTruthy();
    expect(screen.getAllByText("Requirements kept").length).toBeGreaterThan(0);
  });

  it("validates hand edits before saving and saves to the library without overwriting", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Optimise prompt/ }));
    await screen.findByText("Proposed prompt");
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText("Edit the proposed prompt"), { target: { value: "Build it" } });
    fireEvent.click(screen.getByRole("button", { name: /Check requirements in my edit/ }));
    expect(await screen.findAllByText(/1 essential requirement is missing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Accept and save to My prompts/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/library/p-new"));
    const created = calls.find((c) => c.url === "/api/v1/prompts")!;
    expect(created.body.versions).toEqual([
      { prompt_text: PROMPT, provenance: "original" },
      { prompt_text: revision.revised_prompt, provenance: "ai_optimised", change_summary: ["Applied 1 accepted suggestion."] },
      { prompt_text: "Build it", provenance: "user_edited", change_summary: ["Edited by you after review."] },
    ]);
  });

  it("dismissing an unsaved suggestion records feedback; API errors are shown", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Analyse prompt/ }));
    await screen.findByText("Completeness score");
    const card = screen.getByText("Remove repeated instructions").closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/feedback") && c.body.event_type === "suggestion_dismissed" && c.body.suggestion_category === "redundancy")).toBe(true));
    expect(screen.queryByText("Remove repeated instructions")).toBeNull();
    failNext = true;
    fireEvent.click(screen.getByRole("button", { name: /Generate detailed prompt/ }));
    expect(await screen.findByText(/used all 30 prompt analyses/)).toBeTruthy();
  });
});

describe("Studio additions", () => {
  it("shows the live token count, auto-save state and applied preferences, and never saves a draft twice", async () => {
    nextRevision = { ...revision, auto_saved: { prompt_id: "p-auto", original_version_id: "v1", proposed_version_id: "v2" } };
    render(
      <IntelligenceWorkspace
        models={[{ id: "gpt-5-mini", label: "GPT-5 mini" }]}
        defaultModel="gpt-5-mini"
        defaultMode="balanced"
        studio={{ historyEnabled: true, personalisationEnabled: true, savedPreferenceCount: 2, maxPromptChars: 4000, modelOptions: [] }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Studio" })).toBeTruthy();
    expect(screen.getByText(/Auto-save on/)).toBeTruthy();
    expect(screen.getByText("2 saved preferences applied")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: PROMPT } });
    expect(await screen.findByText("4 tokens")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Optimise prompt/ }));
    expect(await screen.findByText("Proposed prompt")).toBeTruthy();
    expect(screen.getByText("tone: friendly")).toBeTruthy();
    expect(screen.getByText("format: kept from your prompt")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Saved to My prompts/ }).getAttribute("href")).toBe("/app/library/p-auto");
    expect(screen.getAllByRole("button", { name: /helpful/i }).length).toBeGreaterThan(0);

    // The next draft goes to the auto-saved prompt instead of creating another one.
    nextRevision = { ...revision, revision_id: "22222222-2222-4222-8222-222222222222" };
    fireEvent.click(screen.getByRole("button", { name: /Generate another version/ }));
    await screen.findByRole("tab", { name: "Draft 2" });
    const second = calls.filter((c) => c.url.endsWith("/optimise")).at(-1)!;
    expect(second.body).toMatchObject({ prompt_id: "p-auto", version_id: "v1" });
    expect(second.body.prompt_text).toBeUndefined();
    expect(screen.getByRole("button", { name: /Accept and save as new version/ })).toBeTruthy();
  });
});

describe("Break down", () => {
  it("breaks a prompt into steps from the analysis hint, with run order, advice and coverage", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Analyse prompt/ }));
    const hint = await screen.findByTestId("breakdown-hint");
    expect(within(hint).getByText(/likely give you a better result/)).toBeTruthy();
    fireEvent.click(within(hint).getByRole("button", { name: "Break it down" }));
    const panel = await screen.findByTestId("breakdown");
    expect(calls.at(-1)).toMatchObject({ url: "/api/v1/prompt-intelligence/breakdown", body: { prompt_text: PROMPT, category: "software_development", target_model: "gpt-5-mini" } });
    expect(within(panel).getByRole("heading", { name: "Write a blog post and create captions" })).toBeTruthy();
    expect(within(panel).getByText(/3 steps · Writing and communication · planned by built-in rules/)).toBeTruthy();
    expect(within(panel).getByRole("list", { name: "Order to run the steps" }).textContent).toMatch(/Write a blog post.*Create captions.*Check everything/);
    expect(within(panel).getByText("After step 1")).toBeTruthy();
    expect(within(panel).getByText("Final check")).toBeTruthy();
    // The placeholder is highlighted so it's hard to miss.
    expect(within(panel).getByText("[Paste the output of step 1 here]").tagName).toBe("MARK");
    expect(within(panel).getByText("Read each answer before moving on.")).toBeTruthy();
    expect(within(panel).getByText("1 of 1 carried")).toBeTruthy();

    fireEvent.click(within(panel).getAllByRole("checkbox", { name: "I've run this step" })[0]!);
    expect(within(panel).getByText("1 of 3 done")).toBeTruthy();
  });

  it("edits a step, saves all steps to My prompts, and moves a step into the editor and back", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Break into smaller prompts/ }));
    const panel = await screen.findByTestId("breakdown");
    fireEvent.click(within(panel).getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.change(within(panel).getByLabelText("Edit step 1 prompt"), { target: { value: "Write a 300-word blog post about cakes." } });

    fireEvent.click(within(panel).getByRole("button", { name: /Save steps to My prompts/ }));
    expect(await within(panel).findByRole("link", { name: /View 3 saved steps/ })).toHaveProperty("href", expect.stringContaining("/app/library?tag=steps-write-a-blog-post"));
    const save = calls.find((c) => c.url.endsWith("/breakdown/save"))!;
    expect(save.body).toMatchObject({ title: "Write a blog post and create captions", category: "writing_communication", target_model: "gpt-5-mini" });
    expect((save.body.steps as Array<{ prompt: string }>)[0]!.prompt).toBe("Write a 300-word blog post about cakes.");

    fireEvent.click(within(panel).getAllByRole("button", { name: "Improve this step in the editor" })[1]!);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Create 3 captions for the post.\n\n[Paste the output of step 1 here]");
    expect(screen.getByText(/Step 2 \(Create captions\) is in the editor/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back to your original prompt/ }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(PROMPT);
  });
});
