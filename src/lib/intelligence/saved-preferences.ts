import type { PreferenceKey } from "@/lib/categories";

/**
 * Saved rewrite preferences (tone, detail, format, audience, language,
 * standing constraints) as prompt lines. A preference is skipped when the
 * prompt already says something about the same thing: what the user wrote in
 * the prompt always wins.
 */
const TONE_TEXT: Record<string, string> = {
  professional_direct: "Use a professional, direct tone.",
  friendly: "Use a warm, friendly tone.",
  formal: "Use a formal tone.",
  neutral: "Use a neutral tone.",
  playful: "Use a light, playful tone.",
};
const DETAIL_TEXT: Record<string, string> = {
  concise: "Keep the answer concise.",
  balanced: "Give a balanced level of detail.",
  detailed: "Be thorough and detailed.",
};
const FORMAT_TEXT: Record<string, string> = {
  natural: "Answer in natural prose.",
  structured: "Use clear headings and short sections.",
  bullet_points: "Format the answer as bullet points.",
  step_by_step: "Present the answer as numbered steps.",
};

const ALREADY_STATED: Record<PreferenceKey, RegExp> = {
  tone: /\b(tone|voice|formal|informal|casual|friendly|professional|playful|witty|neutral|persuasive|humorous)\b/i,
  detail: /\b\d+[\s-]*(words?|sentences?|paragraphs?|pages?|bullets?|points?)\b|\b(short|brief|concise|detailed|thorough|in-depth|comprehensive)\b/i,
  format: /\b(json|csv|table|markdown|bullet|bulleted|numbered|list|headings?|paragraphs?|format(?:ted)?|outline|steps?)\b/i,
  audience: /\b(audience|readers?|for (?:my|our|a|an|the)\b|for (?:[\w-]+\s){0,2}[\w-]+(?:ers|ees|ents|ists)\b)/i,
  language: /\b(in|into) (english|hindi|spanish|french|german|tamil|telugu|marathi|bengali|gujarati|kannada|malayalam|punjabi|urdu|japanese|chinese|arabic|portuguese|italian)\b|\btranslate\b|\brespond in\b/i,
  constraints: /(?!)/,
};

export function savedPreferenceLines(effective: Partial<Record<PreferenceKey, string>>, prompt: string): { lines: string[]; applied: Partial<Record<PreferenceKey, string>>; skipped: PreferenceKey[] } {
  const lines: string[] = [];
  const applied: Partial<Record<PreferenceKey, string>> = {};
  const skipped: PreferenceKey[] = [];
  for (const [key, value] of Object.entries(effective) as Array<[PreferenceKey, string]>) {
    if (!value) continue;
    if (ALREADY_STATED[key].test(prompt)) {
      skipped.push(key);
      continue;
    }
    const line =
      key === "tone"
        ? TONE_TEXT[value]
        : key === "detail"
          ? DETAIL_TEXT[value]
          : key === "format"
            ? FORMAT_TEXT[value]
            : key === "audience"
              ? `The audience is: ${value.replace(/\.$/, "")}.`
              : key === "language"
                ? `Respond in ${value.replace(/\.$/, "")}.`
                : value.endsWith(".")
                  ? value
                  : `${value}.`;
    if (!line) continue;
    lines.push(line);
    applied[key] = value;
  }
  return { lines, applied, skipped };
}
