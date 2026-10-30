import { PREFERENCE_KEYS, type PreferenceKey, type TaskCategory } from "@/lib/categories";

export interface StoredPreference {
  category: string;
  preferenceKey: string;
  preferenceValue: Record<string, unknown>;
  enabled: boolean;
}

export type EffectivePreferences = Partial<Record<PreferenceKey, string>>;

export interface PreferenceResolution {
  effective: EffectivePreferences;
  /** Which source supplied each key, for transparency in the UI. */
  sources: Partial<Record<PreferenceKey, "request" | "category" | "general">>;
}

/** Extract the string value from a stored preference_value object. */
export function preferenceValueString(key: string, value: Record<string, unknown>): string | null {
  const direct = value["value"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const keyed = value[key];
  if (typeof keyed === "string" && keyed.trim()) return keyed.trim();
  return null;
}

export function isPreferenceKey(key: string): key is PreferenceKey {
  return (PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * Preference precedence (FR-004, §13.2):
 *   explicit request preferences  >  saved category preferences  >  saved general preferences
 * Disabled preferences and unknown keys are ignored. When personalisation is off,
 * only the request's explicit preferences apply.
 */
export function resolvePreferences(input: {
  taskCategory: TaskCategory | "auto";
  requestPreferences: Record<string, unknown> | undefined;
  savedPreferences: StoredPreference[];
  personalisationEnabled: boolean;
}): PreferenceResolution {
  const effective: EffectivePreferences = {};
  const sources: PreferenceResolution["sources"] = {};

  if (input.personalisationEnabled) {
    const apply = (category: string, source: "general" | "category") => {
      for (const pref of input.savedPreferences) {
        if (!pref.enabled || pref.category !== category) continue;
        if (!isPreferenceKey(pref.preferenceKey)) continue;
        const value = preferenceValueString(pref.preferenceKey, pref.preferenceValue);
        if (!value) continue;
        effective[pref.preferenceKey] = value;
        sources[pref.preferenceKey] = source;
      }
    };
    apply("general", "general");
    if (input.taskCategory !== "auto" && input.taskCategory !== "general") {
      apply(input.taskCategory, "category");
    }
  }

  for (const [key, raw] of Object.entries(input.requestPreferences ?? {})) {
    if (!isPreferenceKey(key)) continue; // unknown keys are ignored (§10.2)
    if (typeof raw !== "string") continue;
    const value = raw.trim().slice(0, 500);
    if (!value) continue;
    effective[key] = value;
    sources[key] = "request";
  }

  return { effective, sources };
}
