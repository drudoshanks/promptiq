import { describe, expect, it } from "vitest";

import { diffStats, diffWords, originalSide, proposedSide } from "@/lib/diff";
import { exportFileName, parseJsonExport, parseMarkdownExport, renderExport } from "@/lib/export";

const prompt = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Invoice follow-up: client #4471",
  category: "writing",
  tags: ["email", "finance"],
  created_at: "2026-10-30T09:00:00.000Z",
  updated_at: "2026-10-30T09:05:00.000Z",
};

const version = {
  id: "22222222-2222-4222-8222-222222222222",
  version_number: 2,
  provenance: "ai_optimised",
  prompt_text: "Draft an email.\n\nUse ```code``` fences and `inline` ticks.\n\n````\nfour ticks\n````\nTrailing spaces here   \n",
  change_summary: ["Made the ask explicit", "Kept invoice 4471"],
  created_at: "2026-10-30T09:05:00.000Z",
};

describe("exports round-trip (FR-008, PIQ-010)", () => {
  it("TXT is the verbatim prompt, byte for byte (nothing appended)", () => {
    expect(renderExport(prompt, version, "txt")).toBe(version.prompt_text);
    expect(renderExport(prompt, { ...version, prompt_text: "no newline" }, "txt")).toBe("no newline");
  });

  it("JSON parses back to the same prompt and version", () => {
    const text = renderExport(prompt, version, "json");
    const doc = parseJsonExport(text);
    expect(doc.version.prompt_text).toBe(version.prompt_text);
    expect(doc.prompt).toEqual(prompt);
    expect(doc.format).toBe("promptiq.prompt");
  });

  it("Markdown fences the prompt safely even when it contains backtick runs", () => {
    const md = renderExport(prompt, version, "md");
    expect(parseMarkdownExport(md)).toBe(version.prompt_text);
    expect(md).toContain("# Invoice follow-up: client #4471");
    expect(md).toContain("- Made the ask explicit");
    expect(md).toContain("has not been tested");
  });

  it("rejects foreign JSON", () => {
    expect(() => parseJsonExport('{"hello":"world"}')).toThrow();
  });

  it("builds safe file names", () => {
    expect(exportFileName(prompt, version, "md")).toBe("invoice-follow-up-client-4471-v2.md");
    expect(exportFileName({ ...prompt, title: "???" }, version, "txt")).toBe("prompt-v2.txt");
  });
});

describe("word diff (FR-006)", () => {
  it("marks added and removed words and preserves both sides verbatim", () => {
    const before = "write me an email about the invoice";
    const after = "Draft a polite email about invoice 4471";
    const segments = diffWords(before, after);
    const original = originalSide(segments).map((s) => s.text).join("");
    const proposed = proposedSide(segments).map((s) => s.text).join("");
    expect(original).toBe(before);
    expect(proposed).toBe(after);
    const stats = diffStats(segments);
    expect(stats.added).toBeGreaterThan(0);
    expect(stats.removed).toBeGreaterThan(0);
    expect(segments.some((s) => s.type === "equal" && s.text.includes("email"))).toBe(true);
  });

  it("returns a single equal run for identical text", () => {
    const segments = diffWords("same text", "same text");
    expect(segments.every((s) => s.type === "equal")).toBe(true);
  });

  it("falls back gracefully on very large inputs", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const segments = diffWords(big, `${big} extra`);
    expect(segments.length).toBeLessThanOrEqual(2);
  });
});
