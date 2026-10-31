import { isTaskCategory, type TaskCategory } from "@/lib/categories";
import { classifyByRules } from "@/lib/intelligence/classifier";
import { extractRequirements } from "@/lib/intelligence/requirements";
import type { ModelAnalysis, ModelComparison, ModelRevision } from "@/lib/intelligence/schemas";
import { renderPrompt } from "@/lib/intelligence/structure";
import { clauses, similarity } from "@/lib/intelligence/text";
import type { OptimisationOutput } from "@/lib/optimiser/schema";
import { approximateTokens } from "@/lib/tokens";

import type { AiProvider, ComparisonRequest, IntentAnalysisRequest, OptimiseRequest, OptimiseResult, ProviderAttempt, RevisionRequest, StructuredResult } from "./types";

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

  private async wait() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private attempt(inputTokens: number, outputTokens: number): ProviderAttempt[] {
    return [{ attempt: 1, status: "ok", modelId: this.modelId, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 0 } }];
  }

  /** Deterministic stand-in for the model analysis: rule classification and requirement extraction, no extra suggestions. */
  async analyseIntent(request: IntentAnalysisRequest): Promise<StructuredResult<ModelAnalysis>> {
    await this.wait();
    const c = classifyByRules(request.prompt);
    const output: ModelAnalysis = {
      primary_category: c.primary,
      secondary_category: c.secondary,
      objective: c.objective,
      confidence: c.confidence,
      missing_information: c.missing_information,
      requirements: extractRequirements(request.prompt).map((r) => ({ text: r.text, essential: r.essential })),
      suggestions: [],
      already_well_optimised: false,
    };
    return { kind: "ok", output, modelId: this.modelId, attempts: this.attempt(approximateTokens(request.prompt) + 700, 150) };
  }

  /** Deterministic revision: render the structured intent with the category template. */
  async revisePrompt(request: RevisionRequest): Promise<StructuredResult<ModelRevision>> {
    await this.wait();
    let text = renderPrompt(request.intent, request.template, { mode: request.mode, acceptedKinds: request.acceptedKinds, acceptedChanges: request.acceptedChanges, customObjective: request.customObjective, questions: request.questions });
    if (request.restore.length) text = `${text}\n\nAlso required:\n${request.restore.map((r) => `- ${r.replace(/^([-*•]|\d+[.)])\s+/, "")}`).join("\n")}`;
    const improvements: string[] = [];
    if (request.mode === "detailed" || request.mode === "quality_first") improvements.push(`Organised into ${request.template.label.toLowerCase()} sections so nothing is left implicit.`);
    if (request.mode === "token_saver") improvements.push("Removed filler, repetition and wordy phrasing.");
    if (request.mode === "balanced") improvements.push("Grouped requirements, constraints and format so each is stated once.");
    if (request.mode === "custom" && request.customObjective) improvements.push(`Rewritten for your objective: ${request.customObjective.slice(0, 80)}.`);
    if (request.acceptedChanges.length) improvements.push(`Applied ${request.acceptedChanges.length} accepted suggestion${request.acceptedChanges.length > 1 ? "s" : ""}.`);
    if (request.intent.missing_information.length) improvements.push("Marked missing information as editable placeholders instead of guessing.");
    if (request.restore.length) improvements.push(`Restored ${request.restore.length} requirement${request.restore.length > 1 ? "s" : ""} an earlier draft dropped.`);
    const output: ModelRevision = { revised_prompt: text, key_improvements: improvements, assumptions_introduced: request.intent.assumptions, clarification_questions: request.questions.filter((q) => request.intent.missing_information.includes(q.key)).map((q) => q.question) };
    return { kind: "ok", output, modelId: this.modelId, attempts: this.attempt(approximateTokens(request.prompt) + 900, approximateTokens(text) + 80) };
  }

  /** Lenient wording comparison standing in for the semantic check. */
  async compareRequirements(request: ComparisonRequest): Promise<StructuredResult<ModelComparison>> {
    await this.wait();
    const parts = clauses(request.revised).map((c) => c.text);
    const output: ModelComparison = {
      items: request.items.map((item) => {
        const best = Math.max(0, ...parts.map((p) => similarity(item.text, p)));
        return { id: item.id, status: best >= 0.5 ? "preserved" : best >= 0.3 ? "changed" : "missing", note: best >= 0.5 ? null : "Closest wording in the revision differs." };
      }),
    };
    return { kind: "ok", output, modelId: this.modelId, attempts: this.attempt(approximateTokens(request.revised) + 300, 40 + request.items.length * 12) };
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
