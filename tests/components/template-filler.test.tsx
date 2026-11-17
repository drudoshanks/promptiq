// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateFiller } from "@/components/prompt-library/template-filler";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const TEXT = "Write a short note to {{recipient}} about {{topic}}. Keep it friendly.";
const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/save") ? new Response(JSON.stringify({ data: { prompt_id: "p-1", title: "Note" } }), { status: 201, headers: { "content-type": "application/json" } }) : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TemplateFiller", () => {
  it("shows the blanks and fills the preview as you type", () => {
    render(<TemplateFiller slug="short-note" promptText={TEXT} variables={["recipient", "topic"]} />);
    expect(screen.getByText("2 of 2 still empty.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Asha" } });
    const preview = screen.getByTestId("library-preview");
    expect(preview.textContent).toContain("Write a short note to Asha about {{topic}}");
    expect(screen.getByText("1 of 2 still empty.")).toBeTruthy();
  });

  it("opens the filled prompt in the Studio", () => {
    render(<TemplateFiller slug="short-note" promptText={TEXT} variables={["recipient", "topic"]} />);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "the launch" } });
    fireEvent.click(screen.getByRole("button", { name: /Open in Studio/ }));
    expect(sessionStorage.getItem("piq:library:short-note")).toBe("Write a short note to {{recipient}} about the launch. Keep it friendly.");
    expect(push).toHaveBeenCalledWith("/app/studio?template=short-note");
  });

  it("saves only the filled values to My prompts", async () => {
    render(<TemplateFiller slug="short-note" promptText={TEXT} variables={["recipient", "topic"]} />);
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "Asha" } });
    fireEvent.click(screen.getByRole("button", { name: /Save to My prompts/ }));
    await waitFor(() => expect(screen.getByText(/Open it in My prompts/)).toBeTruthy());
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/save"))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ values: { recipient: "Asha" } });
  });
});
