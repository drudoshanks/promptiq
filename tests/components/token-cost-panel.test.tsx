// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenCostPanel } from "@/components/estimates/token-cost-panel";
import type { ModelOption } from "@/lib/client/estimates";
import type { OutputLengthPreset } from "@/lib/config/estimates";

const models: ModelOption[] = [
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", encoding: "o200k_base", pricing: null },
  { id: "gpt-9", label: "GPT-9", provider: "openai", encoding: "o200k_base", pricing: null },
];

/** Fake API: token count = word count, so expectations are easy to read. */
function words(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { model: string; text?: string; original_text?: string; optimised_text?: string };
  if (body.model === "gpt-9") return json({ error: { code: "UNSUPPORTED_MODEL", message: 'Token counting is not supported for model "gpt-9".', details: {} } }, 422);
  const count = (t: string) => ({ model: body.model, encoding: "o200k_base", token_count: words(t), character_count: t.length, count_type: "text_token_estimate", tokenizer_version: "test" });
  if (body.text !== undefined) return json({ data: { ...count(body.text), cost: null, pricing_warning: "No pricing is configured for gpt-4o; token counts are shown without a cost.", limitations: "" } });
  const o = words(body.original_text ?? "");
  const n = words(body.optimised_text ?? "");
  return json({
    data: {
      model: body.model,
      encoding: "o200k_base",
      tokenizer_version: "test",
      original: count(body.original_text ?? ""),
      optimised: count(body.optimised_text ?? ""),
      tokens_saved: o - n,
      reduction_percent: o ? Math.round(((o - n) / o) * 1000) / 10 : 0,
      is_smaller: n < o,
      cost: null,
      pricing_warning: null,
      limitations: "",
    },
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ initialOptimised }: { initialOptimised: string }) {
  const [optimised, setOptimised] = useState(initialOptimised);
  const [model, setModel] = useState("gpt-4o");
  const [preset, setPreset] = useState<OutputLengthPreset>("medium");
  return (
    <>
      <textarea aria-label="Your version" value={optimised} onChange={(e) => setOptimised(e.target.value)} />
      <TokenCostPanel original="one two three four five six" optimised={optimised} models={models} model={model} onModelChange={setModel} outputPreset={preset} onOutputPresetChange={setPreset} />
    </>
  );
}

describe("TokenCostPanel (§7; tests 12, 15)", () => {
  it("compares original and optimised counts, labelled as estimates", async () => {
    render(<Harness initialOptimised="one two three" />);
    await waitFor(() => expect(screen.getByTestId("tokens-change").textContent).toBe("3 fewer (50% smaller)"));
    expect(screen.getByTestId("tokens-original").textContent).toBe("6");
    expect(screen.getByText("estimate")).toBeTruthy();
    expect(screen.getByText(/cannot see your actual usage/)).toBeTruthy();
  });

  it("recounts after the optimised prompt is edited, debounced into one request", async () => {
    render(<Harness initialOptimised="one two three" />);
    await waitFor(() => expect(screen.getByTestId("tokens-optimised").textContent).toBe("3"));
    const callsBefore = fetchMock.mock.calls.length;

    const editor = screen.getByLabelText("Your version");
    act(() => {
      fireEvent.change(editor, { target: { value: "one two three four five six seven eight" } });
      fireEvent.change(editor, { target: { value: "one two three four five six seven eight nine" } });
    });

    await waitFor(() => expect(screen.getByTestId("tokens-optimised").textContent).toBe("9"));
    expect(screen.getByTestId("tokens-change").textContent).toBe("3 more (50% larger)");
    // Two quick edits produced a single network request.
    expect(fetchMock.mock.calls.length - callsBefore).toBe(1);
    const lastBody = JSON.parse(String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body));
    expect(lastBody.optimised_text).toBe("one two three four five six seven eight nine");
  });

  it("shows an unsupported-model state instead of a number", async () => {
    render(<Harness initialOptimised="one" />);
    await waitFor(() => expect(screen.getByTestId("tokens-optimised")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Model you will use"), { target: { value: "gpt-9" } });
    await waitFor(() => expect(screen.getByText("This model is not supported for counting")).toBeTruthy());
    expect(screen.queryByTestId("tokens-optimised")).toBeNull();
  });

  it("shows the missing-pricing warning for a single text", async () => {
    render(<TokenCostPanel original="hello there" models={models} model="gpt-4o" onModelChange={() => undefined} outputPreset="short" onOutputPresetChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("tokens-single").textContent).toBe("2"));
    expect(screen.getByText(/No pricing is configured/)).toBeTruthy();
    expect(screen.getByText("Not available for this model")).toBeTruthy();
  });

  it("separates PromptIQ's actual usage from estimates", async () => {
    render(
      <TokenCostPanel
        original="a b"
        optimised="a"
        models={models}
        model="gpt-4o"
        onModelChange={() => undefined}
        outputPreset="short"
        onOutputPresetChange={() => undefined}
        actualUsage={{
          attempts: [],
          attempt_count: 2,
          unreported_attempts: 1,
          total_input_tokens: 900,
          total_output_tokens: 120,
          total_tokens: 1020,
          total_cached_input_tokens: 0,
          actual_cost: 0.000465,
          currency: "USD",
          pricing_version: "v",
          usage_source: "provider",
        }}
      />,
    );
    expect(screen.getByText("actual")).toBeTruthy();
    expect(screen.getByText(/used 900 input and 120 output tokens, \$0.000465 across 2 provider attempts/)).toBeTruthy();
    expect(screen.getByText(/1 attempt\(s\) returned no usage data/)).toBeTruthy();
  });

  it("asks for a prompt when there is no text", () => {
    render(<TokenCostPanel original="" models={models} model="gpt-4o" onModelChange={() => undefined} outputPreset="short" onOutputPresetChange={() => undefined} />);
    expect(screen.getByText("Enter a prompt to see its token count.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
