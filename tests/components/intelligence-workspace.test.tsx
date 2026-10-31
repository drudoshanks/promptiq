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
  if (url.endsWith("/optimise") || url.endsWith("/generate")) return json(revision, 201);
  if (url.endsWith("/validate")) return json({ preservation: { ...revision.preservation, status: "failed", summary: "1 essential requirement is missing or reversed." }, estimate: { ...revision.estimate, optimised: count(2) } });
  if (url === "/api/v1/prompts") return json({ id: "p-new" }, 201);
  return json({ recorded: true }, 201);
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
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
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/library/p-new"));
    const created = calls.find((c) => c.url === "/api/v1/prompts")!;
    expect(created.body.versions).toEqual([
      { prompt_text: PROMPT, provenance: "original" },
      { prompt_text: "Build it", provenance: "user_edited", change_summary: ["Applied 1 accepted suggestion."] },
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
