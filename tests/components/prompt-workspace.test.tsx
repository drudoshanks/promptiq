// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptWorkspace } from "@/components/library/prompt-workspace";
import type { SerialisedSuggestion } from "@/lib/services/analysis";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const suggestion = (id: string, status = "pending"): SerialisedSuggestion => ({
  id,
  analysis_id: "a1",
  prompt_id: "p1",
  prompt_version_id: "v1",
  category: "output_format",
  category_label: "Output format",
  priority: "medium",
  title: `Suggestion ${id}`,
  explanation: "No format given.",
  recommendation: "Ask for 5 bullet points.",
  estimated_token_impact: "low",
  token_direction: "increase",
  requires_user_context: false,
  context_question: null,
  status: status as SerialisedSuggestion["status"],
  applied_version_id: null,
  feedback_at: null,
  created_at: "2026-10-30T00:00:00Z",
});

const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = init.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url, method: String(init.method), body });
  if (url.startsWith("/api/v1/suggestions/")) return json({ data: { ...suggestion("s1"), status: body.status } });
  if (url.endsWith("/optimise"))
    return json({
      data: {
        optimisation_id: "run-1",
        source_version_id: "v1",
        suggestion_ids: body.suggestion_ids,
        optimisation_mode: body.mode,
        original_prompt: "Write about cats.",
        optimised_prompt: "Write about cats in 5 bullet points.",
        change_summary: ["Asked for 5 bullet points."],
        quality_risks: [],
        clarifying_questions: [],
        actual_usage: null,
      },
    });
  if (url.endsWith("/versions")) return json({ data: { id: "v2", version_number: 2 } }, 201);
  if (url === "/api/v1/token-estimates") return json({ error: { code: "UNSUPPORTED_MODEL", message: "x", details: {} } }, 422);
  return json({ data: {} });
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PromptWorkspace (§6; criteria 8, 9)", () => {
  it("accepts a suggestion, optimises with it, lets the user edit, and saves a new version linked to the run", async () => {
    render(
      <PromptWorkspace
        promptId="p1"
        currentVersion={{ id: "v1", number: 1, text: "Write about cats." }}
        targetModel="gpt-4o"
        defaultMode="balanced"
        models={[{ id: "gpt-4o", label: "GPT-4o", provider: "openai", encoding: "o200k_base", pricing: null }]}
        initialAnalysis={{
          id: "a1",
          prompt_id: "p1",
          prompt_version_id: "v1",
          analysis_status: "completed",
          overall_quality_score: 70,
          score_note: "Heuristic",
          already_well_optimised: false,
          summary: "1 possible improvement.",
          recommended_actions: [],
          target_model: "gpt-4o",
          model_id: "mock",
          template_version: "t",
          actual_usage: { input_tokens: 1, output_tokens: 1, actual_cost: 0 },
          error_code: null,
          created_at: "2026-10-30T00:00:00Z",
          completed_at: "2026-10-30T00:00:00Z",
        }}
        initialSuggestions={[suggestion("s1")]}
        analysedVersionNumber={1}
      />,
    );

    expect(screen.getByText(/heuristic indicator/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeTruthy());
    expect(calls[0]).toMatchObject({ url: "/api/v1/suggestions/s1", method: "PATCH", body: { status: "accepted" } });

    fireEvent.click(screen.getByLabelText(/Token saver/));
    fireEvent.click(screen.getByRole("button", { name: "Optimise prompt" }));
    await waitFor(() => expect(screen.getByLabelText("Edit before saving")).toBeTruthy());
    const optimiseCall = calls.find((c) => c.url.endsWith("/optimise"));
    expect(optimiseCall?.body).toMatchObject({ mode: "token_saver", suggestion_ids: ["s1"], version_id: "v1", target_model: "gpt-4o" });
    // Nothing saved yet: the original is never overwritten automatically.
    expect(calls.some((c) => c.url.endsWith("/versions"))).toBe(false);

    fireEvent.change(screen.getByLabelText("Edit before saving"), { target: { value: "Write about cats in 5 bullet points for children." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as version 2" }));
    await waitFor(() => expect(screen.getByText(/Saved as a new version/)).toBeTruthy());
    const save = calls.find((c) => c.url.endsWith("/versions"));
    expect(save?.body).toMatchObject({
      prompt_text: "Write about cats in 5 bullet points for children.",
      provenance: "user_edited",
      optimisation_id: "run-1",
      suggestion_ids: ["s1"],
      parent_version_id: "v1",
    });
    expect(screen.getByText("Applied")).toBeTruthy();
  });

  it("warns when suggestions belong to an older version", () => {
    render(
      <PromptWorkspace
        promptId="p1"
        currentVersion={{ id: "v3", number: 3, text: "x" }}
        targetModel="gpt-4o"
        defaultMode="balanced"
        models={[]}
        initialAnalysis={{ id: "a1", prompt_id: "p1", prompt_version_id: "v1", analysis_status: "completed", overall_quality_score: 50, score_note: "", already_well_optimised: false, summary: "", recommended_actions: [], target_model: null, model_id: "m", template_version: "t", actual_usage: { input_tokens: null, output_tokens: null, actual_cost: null }, error_code: null, created_at: "2026-10-30T00:00:00Z", completed_at: null }}
        initialSuggestions={[]}
        analysedVersionNumber={1}
      />,
    );
    expect(screen.getByText(/These suggestions are for version 1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyse current version" })).toBeTruthy();
  });
});
