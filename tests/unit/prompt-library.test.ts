import { describe, expect, it } from "vitest";

import seed from "../../db/seed/prompt-library.json";
import { fillPrompt, isLibraryCategory, promptVariables, variableLabel } from "@/lib/prompt-library/categories";

describe("prompt library blanks", () => {
  it("finds {{fields}} in order, once each", () => {
    expect(promptVariables("Hi {{name}}, about {{ topic }} and {{name}} again. {{1bad}} {{}}")).toEqual(["name", "topic"]);
  });

  it("fills given values and leaves the rest as blanks", () => {
    const text = "Write to {{recipient}} about {{topic}} in {{tone}}.";
    expect(fillPrompt(text, { recipient: "Asha", topic: "  ", tone: "a warm tone" })).toBe("Write to Asha about {{topic}} in a warm tone.");
  });

  it("does not treat $ patterns in values specially", () => {
    expect(fillPrompt("Price: {{price}}", { price: "$& $1 $$" })).toBe("Price: $& $1 $$");
  });

  it("labels fields for people", () => {
    expect(variableLabel("word_count")).toBe("Word count");
    expect(variableLabel("target audience")).toBe("Target audience");
  });
});

describe("prompt library seed", () => {
  it("is well formed", () => {
    expect(seed.length).toBeGreaterThan(200);
    const slugs = new Set<string>();
    for (const item of seed) {
      expect(item.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slugs.has(item.slug)).toBe(false);
      slugs.add(item.slug);
      expect(isLibraryCategory(item.category)).toBe(true);
      expect(item.title.length).toBeGreaterThan(2);
      expect(item.description.length).toBeGreaterThan(10);
      expect(item.prompt.length).toBeGreaterThanOrEqual(100);
      expect(item.prompt.length).toBeLessThanOrEqual(4000);
    }
  });

  it("records where every prompt came from and its licence", () => {
    for (const item of seed) {
      if (item.source === "awesome-chatgpt-prompts") {
        expect(item.license).toBe("CC0-1.0");
        expect(item.source_url).toMatch(/^https:\/\/github\.com\/f\/awesome-chatgpt-prompts/);
      } else {
        expect(item.source).toBe("promptiq");
        expect(item.license).toBe("PromptIQ original");
      }
    }
    expect(seed.filter((i) => i.source === "promptiq").length).toBeGreaterThan(50);
  });

  it("leaves out sensitive role-plays", () => {
    const text = seed.map((i) => `${i.title} ${i.prompt}`).join("\n");
    expect(text).not.toMatch(/\bjailbreak\b|\bDAN\b|\bcasino\b|\bnsfw\b/i);
  });
});
