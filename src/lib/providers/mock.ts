import { isTaskCategory, type TaskCategory } from "@/lib/categories";
import type { AnalysisOutput, AnalysisSuggestion } from "@/lib/analysis/schema";
import type { OptimisationOutput } from "@/lib/optimiser/schema";
import { approximateTokens } from "@/lib/tokens";

import type { AiProvider, AnalyseRequest, AnalyseResult, OptimiseRequest, OptimiseResult } from "./types";

const CATEGORY_HINTS: Array<[TaskCategory, RegExp]> = [
  ["coding", /\b(code|function|bug|error|typescript|python|javascript|sql|api|regex|compile|refactor|unit test)\b/i],
  ["summarisation", /\b(summari[sz]e|summary|tl;?dr|condense|recap)\b/i],
  ["extraction", /\b(extract|parse|pull out|list all|fields?|json|csv|table of)\b/i],
  ["planning", /\b(plan|roadmap|schedule|milestones?|timeline|steps to|strategy)\b/i],
  ["research", /\b(research|sources?|compare|literature|evidence|cite|citations?|investigate)\b/i],
  ["writing", /\b(write|draft|email|post|essay|article|blog|letter|caption|copy|rewrite|tone)\b/i],
];

function classify(prompt: string): TaskCategory {
  for (const [category, pattern] of CATEGORY_HINTS) {
    if (pattern.test(prompt)) return category;
  }
  return "general";
}

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

/**
 * Deterministic local optimiser for development, tests and the evaluation
 * harness. It never invents content: the original text is kept verbatim and
 * explicit requirement lines are appended from the resolved preferences.
 */
export class MockOptimiserProvider implements AiProvider {
  readonly name = "mock" as const;
  readonly modelId = "mock-optimiser";
  private readonly latencyMs: number;

  constructor(options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs ?? 0;
  }

  /**
   * Deterministic heuristic review used for development, tests and the
   * evaluation harness. It applies the same personalisation contract as the
   * real analyser: preferred token priority changes priorities, and categories
   * the user keeps dismissing are skipped.
   */
  async analyse(request: AnalyseRequest): Promise<AnalyseResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const output = heuristicAnalysis(request);
    const inputTokens = approximateTokens(request.prompt) + 900;
    const outputTokens = 80 + output.suggestions.length * 60;
    return {
      kind: "ok",
      output,
      modelId: this.modelId,
      attempts: [{ attempt: 1, status: "ok", modelId: this.modelId, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 0 } }],
    };
  }

  async optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const category = isTaskCategory(request.taskCategory) ? request.taskCategory : classify(request.prompt);
    const changes: string[] = [];
    const risks: string[] = [];
    const assumptions: string[] = [];

    if (/ignore (all|your|previous) (instructions|rules)|reveal (your|the) (system|instructions)/i.test(request.prompt)) {
      risks.push("The prompt contains an instruction-override attempt; it was treated as text and not followed.");
    }

    let body = request.prompt.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    if (body !== request.prompt) changes.push("Collapsed repeated spaces and blank lines without changing wording.");

    const mode = request.mode ?? "balanced";
    if (mode === "token_saver" || mode === "balanced") {
      const trimmed = removeFiller(body);
      if (trimmed !== body) {
        body = trimmed;
        changes.push("Removed filler wording and repeated sentences; every requirement was kept.");
      }
    }
    if (mode === "quality_first" && !FORMAT_WORDS.test(body)) {
      body = `${body}\n\nState the answer format you need (for example: bullet points, a table or a short paragraph).`;
      changes.push("Asked for an explicit output format, because none was given.");
    }
    if (mode === "custom" && request.customObjective?.trim()) {
      changes.push(`Followed your objective: ${request.customObjective.trim().slice(0, 80)}.`);
    }
    for (const accepted of request.acceptedSuggestions ?? []) {
      body = `${body}\n- ${accepted.replace(/\.$/, "")}.`;
      changes.push(`Applied your accepted suggestion: ${accepted.slice(0, 80)}.`);
    }

    const requirementLines: string[] = [];
    const { tone, detail, format, audience, language, constraints } = request.preferences;
    if (tone && TONE_TEXT[tone]) requirementLines.push(TONE_TEXT[tone]);
    if (detail && DETAIL_TEXT[detail]) requirementLines.push(DETAIL_TEXT[detail]);
    if (format && FORMAT_TEXT[format]) requirementLines.push(FORMAT_TEXT[format]);
    if (audience) requirementLines.push(`The audience is: ${audience}.`);
    if (language) requirementLines.push(`Respond in ${language}.`);
    if (constraints) requirementLines.push(constraints.endsWith(".") ? constraints : `${constraints}.`);

    const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 6) {
      assumptions.push("The prompt is very short; the deliverable was left as the user wrote it rather than guessed.");
    }

    if (requirementLines.length) {
      body = `${body}\n\nRequirements:\n${requirementLines.map((l) => `- ${l}`).join("\n")}`;
      changes.push(`Made ${requirementLines.length} implicit requirement${requirementLines.length > 1 ? "s" : ""} explicit from your saved preferences.`);
    }
    if (changes.length === 0) changes.push("No wording changes were needed; the prompt already states its intent clearly.");

    const output: OptimisationOutput = {
      optimised_prompt: body,
      task_category: category,
      change_summary: changes,
      assumptions,
      clarification_needed: false,
      clarifying_questions: [],
      estimated_input_tokens_before: approximateTokens(request.prompt),
      estimated_input_tokens_after: approximateTokens(body),
      quality_risks: risks,
    };

    // Deterministic stand-in for provider usage: instructions overhead + text.
    const inputTokens = approximateTokens(request.prompt) + 600;
    const outputTokens = approximateTokens(body) + 60;
    return {
      kind: "ok",
      output,
      modelId: this.modelId,
      attempts: [
        {
          attempt: 1,
          status: "ok",
          modelId: this.modelId,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 0 },
        },
      ],
    };
  }
}

const FILLER = [
  /\b(?:please|kindly)\s+/gi,
  /\bcould you\s+(?:please\s+)?/gi,
  /\bI would like you to\s+/gi,
  /\bI want you to\s+/gi,
  /\b(?:basically|actually|really|just)\s+/gi,
  /\bif possible,?\s*/gi,
];
const FORMAT_WORDS = /\b(format|bullet|table|json|csv|list|paragraph|heading|markdown|words?|sentences?|steps?)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

/** Remove politeness filler and exact duplicate sentences. Never touches numbers, quotes or code. */
export function removeFiller(text: string): string {
  if (/```/.test(text)) return text;
  let out = text;
  for (const re of FILLER) out = out.replace(re, "");
  const seen = new Set<string>();
  const kept = sentences(out).filter((s) => {
    const key = s.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  out = text.includes("\n") ? out : kept.join(" ");
  // Re-capitalise a sentence whose first word was removed.
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()).trim();
}

function heuristicAnalysis(request: AnalyseRequest): AnalysisOutput {
  const text = request.prompt;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const priority = (request.preferences["token_efficiency_priority"] as string | null) ?? "balanced";
  const s: AnalysisSuggestion[] = [];
  const add = (x: Omit<AnalysisSuggestion, "context_question" | "requires_user_context"> & { context_question?: string }) =>
    s.push({ requires_user_context: Boolean(x.context_question), context_question: x.context_question ?? null, ...x });

  if (/ignore (all|your|previous) (instructions|rules)|rate this/i.test(text)) {
    add({ category: "clarity", priority: "high", title: "Remove the embedded instruction", explanation: "The prompt contains an instruction aimed at the reviewing tool rather than at the assistant.", recommendation: "Delete the embedded instruction and keep only the task.", estimated_token_impact: "low", token_direction: "reduce" });
  }
  if (words.length < 8) {
    add({ category: "clarity", priority: "high", title: "State the goal and deliverable", explanation: `The prompt has only ${words.length} words, so the assistant has to guess what you want.`, recommendation: "Say what you want produced, for whom, and how long it should be.", estimated_token_impact: "medium", token_direction: "increase", context_question: "What exactly should the answer contain, and who is it for?" });
  }
  if (/\bshort\b|\bbrief\b|\bconcise\b/i.test(text) && /\bdetailed\b|\bthorough\b|\bcomprehensive\b/i.test(text)) {
    add({ category: "conflicting_constraints", priority: "high", title: "Resolve short versus detailed", explanation: "The prompt asks for both a short and a detailed answer.", recommendation: "Choose one, or say which parts should be brief and which detailed.", estimated_token_impact: "low", token_direction: "neutral" });
  }
  const dupes = sentences(text).length - new Set(sentences(text).map((x) => x.trim().toLowerCase())).size;
  if (dupes > 0) {
    add({ category: "repetition", priority: "medium", title: "Remove repeated sentences", explanation: `${dupes} sentence${dupes > 1 ? "s are" : " is"} repeated word for word.`, recommendation: "Keep each requirement once.", estimated_token_impact: "medium", token_direction: "reduce" });
  }
  if (removeFiller(text) !== text && FILLER.some((re) => new RegExp(re.source, "i").test(text))) {
    add({ category: "verbosity", priority: "low", title: "Drop filler phrases", explanation: "Phrases such as \"please\" or \"could you\" add tokens without adding instructions.", recommendation: "Write the instructions directly; the meaning stays the same.", estimated_token_impact: "low", token_direction: "reduce" });
  }
  if (/\b(stuff|things|etc\.?|some|good|nice)\b/i.test(text)) {
    add({ category: "ambiguity", priority: "medium", title: "Replace vague words", explanation: "Words like \"stuff\", \"things\" or \"good\" leave the assistant to guess what you mean.", recommendation: "Name the specific items or quality criteria you have in mind.", estimated_token_impact: "low", token_direction: "increase", context_question: "Which specific items or criteria do you mean?" });
  }
  if (words.length >= 8 && !FORMAT_WORDS.test(text)) {
    add({ category: "output_format", priority: "medium", title: "Specify the output format", explanation: "The prompt does not say how the answer should be laid out or how long it should be.", recommendation: "Add the format and length you need, for example \"5 bullet points\" or \"under 150 words\".", estimated_token_impact: "low", token_direction: "increase" });
  }
  if (words.length >= 8 && !/\b(audience|for\s+\w+|readers?|as an? )/i.test(text)) {
    add({ category: "role_audience", priority: "low", title: "Say who the answer is for", explanation: "Without an audience the assistant picks a generic register.", recommendation: "Name the reader, for example \"for non-technical managers\".", estimated_token_impact: "low", token_direction: "increase" });
  }
  if (priority === "high" && words.length > 60) {
    add({ category: "token_efficiency", priority: "medium", title: "Tighten long instructions", explanation: `The prompt runs to ${words.length} words; you prefer token-efficient prompts.`, recommendation: "Merge overlapping instructions and remove background the assistant does not need.", estimated_token_impact: "medium", token_direction: "reduce" });
  }

  // Personalisation: token priority adjusts token-related suggestions; categories
  // the user has dismissed repeatedly (and never accepted) are skipped.
  const tokenCats = new Set(["repetition", "verbosity", "token_efficiency"]);
  for (const x of s) {
    if (!tokenCats.has(x.category)) continue;
    if (priority === "high") x.priority = "high";
    if (priority === "low") x.priority = "low";
  }
  const skipped: string[] = [];
  const filtered = s.filter((x) => {
    const h = request.feedbackHistory[x.category];
    if (h && h.dismissed >= 2 && h.accepted === 0 && x.priority !== "high") {
      skipped.push(x.category);
      return false;
    }
    return true;
  });
  const order = { high: 0, medium: 1, low: 2 } as const;
  filtered.sort((a, b) => order[a.priority] - order[b.priority]);

  const penalty = filtered.reduce((n, x) => n + (x.priority === "high" ? 20 : x.priority === "medium" ? 10 : 5), 0);
  const already = filtered.length === 0;
  return {
    overall_quality_score: already ? 92 : Math.max(20, 100 - penalty),
    already_well_optimised: already,
    summary: already
      ? "Already well optimised: the goal, format and constraints are clear. No changes needed."
      : `${filtered.length} possible improvement${filtered.length > 1 ? "s" : ""}.${skipped.length ? ` Skipped ${skipped.join(", ")} based on your earlier feedback.` : ""}`,
    suggestions: filtered,
    recommended_actions: filtered.slice(0, 3).map((x) => x.title),
  };
}
