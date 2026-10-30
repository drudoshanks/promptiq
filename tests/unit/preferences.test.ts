import { describe, expect, it } from "vitest";

import { resolvePreferences, type StoredPreference } from "@/lib/optimiser/preferences";

const saved: StoredPreference[] = [
  { category: "general", preferenceKey: "tone", preferenceValue: { value: "friendly" }, enabled: true },
  { category: "general", preferenceKey: "detail", preferenceValue: { value: "concise" }, enabled: true },
  { category: "writing", preferenceKey: "tone", preferenceValue: { value: "formal" }, enabled: true },
  { category: "coding", preferenceKey: "format", preferenceValue: { value: "step_by_step" }, enabled: false },
  { category: "general", preferenceKey: "not_a_key", preferenceValue: { value: "x" }, enabled: true },
  { category: "general", preferenceKey: "audience", preferenceValue: { audience: "engineers" }, enabled: true },
];

describe("preference precedence (FR-004, §13.2)", () => {
  it("category preferences override general ones", () => {
    const { effective, sources } = resolvePreferences({ taskCategory: "writing", requestPreferences: undefined, savedPreferences: saved, personalisationEnabled: true });
    expect(effective.tone).toBe("formal");
    expect(sources.tone).toBe("category");
    expect(effective.detail).toBe("concise");
    expect(sources.detail).toBe("general");
  });

  it("explicit request preferences override everything", () => {
    const { effective, sources } = resolvePreferences({ taskCategory: "writing", requestPreferences: { tone: "playful" }, savedPreferences: saved, personalisationEnabled: true });
    expect(effective.tone).toBe("playful");
    expect(sources.tone).toBe("request");
  });

  it("ignores disabled preferences and unknown keys", () => {
    const { effective } = resolvePreferences({ taskCategory: "coding", requestPreferences: { bogus: "1", language: "" }, savedPreferences: saved, personalisationEnabled: true });
    expect(effective.format).toBeUndefined();
    expect("bogus" in effective).toBe(false);
    expect(effective.language).toBeUndefined();
  });

  it("reads legacy { key: value } shapes", () => {
    const { effective } = resolvePreferences({ taskCategory: "general", requestPreferences: undefined, savedPreferences: saved, personalisationEnabled: true });
    expect(effective.audience).toBe("engineers");
  });

  it("applies only request preferences when personalisation is off", () => {
    const { effective } = resolvePreferences({ taskCategory: "writing", requestPreferences: { detail: "detailed" }, savedPreferences: saved, personalisationEnabled: false });
    expect(effective).toEqual({ detail: "detailed" });
  });
});
