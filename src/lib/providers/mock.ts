import { isTaskCategory, type TaskCategory } from "@/lib/categories";
import type { OptimisationOutput } from "@/lib/optimiser/schema";
import { approximateTokens } from "@/lib/tokens";

import type { OptimiseRequest, OptimiseResult, OptimiserProvider } from "./types";

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
export class MockOptimiserProvider implements OptimiserProvider {
  readonly name = "mock" as const;
  readonly modelId = "mock-optimiser";
  private readonly latencyMs: number;

  constructor(options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs ?? 0;
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
