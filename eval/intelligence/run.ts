/**
 * Prompt Intelligence evaluation (§15).
 *
 *   npm run eval:intelligence                         # local provider (deterministic)
 *   OPTIMISER_PROVIDER=openai npm run eval:intelligence -- --live --limit 5
 *
 * For every case in eval/intelligence/dataset.json it measures, per generation
 * mode: classification agreement, missing-information recall, coverage of the
 * listed must-preserve requirements, the automated preservation verdict, and
 * token counts and estimated input cost before and after.
 *
 * With --live (OpenAI only) it also runs the ORIGINAL and the IMPROVED prompt
 * as tasks on the target model and applies the same output checks to both
 * answers, so task success and format compliance are compared like for like.
 * Prompt length and the heuristic score are reported but never used alone as
 * a measure of quality.
 */
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import { classifyByRules } from "../../src/lib/intelligence/classifier";
import { reviseText } from "../../src/lib/intelligence/engine";
import { INTELLIGENCE_TEMPLATE_VERSION } from "../../src/lib/intelligence/instructions";
import { scorePrompt } from "../../src/lib/intelligence/scorer";
import type { GenerationMode } from "../../src/lib/intelligence/categories";
import { MockOptimiserProvider } from "../../src/lib/providers/mock";
import { OpenAIOptimiserProvider } from "../../src/lib/providers/openai";
import type { AiProvider } from "../../src/lib/providers/types";
import { compareTokenCounts } from "../../src/lib/tokens";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

interface OutputCheck {
  type: "includes" | "excludes" | "max_words";
  value: string | number;
}
interface Case {
  id: string;
  prompt: string;
  category: string;
  must_preserve: string[];
  expected_missing: string[];
  output_checks: OutputCheck[];
}

/** Input prices per million tokens used for the report (keep in step with model_pricing). */
const INPUT_PER_MILLION: Record<string, number> = { "gpt-5-mini": 0.25, "gpt-5-nano": 0.05, "gpt-4o": 2.5 };
const MODES: GenerationMode[] = ["detailed", "balanced", "token_saver"];

function args() {
  const a = process.argv.slice(2);
  const get = (f: string) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
  return { live: a.includes("--live"), limit: Number(get("--limit") ?? 0) || 0, model: get("--model") ?? "gpt-5-mini" };
}

function provider(): AiProvider {
  if (process.env.OPTIMISER_PROVIDER !== "openai") return new MockOptimiserProvider();
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for OPTIMISER_PROVIDER=openai");
  return new OpenAIOptimiserProvider({ apiKey: process.env.OPENAI_API_KEY, modelId: process.env.OPTIMISER_MODEL ?? "gpt-5-mini", timeoutMs: 60_000, reasoningEffort: "low" });
}

function check(answer: string, c: OutputCheck): boolean {
  const a = answer.toLowerCase();
  if (c.type === "includes") return a.includes(String(c.value).toLowerCase());
  if (c.type === "excludes") return !a.includes(String(c.value).toLowerCase());
  return answer.trim().split(/\s+/).length <= Number(c.value);
}

async function runTask(client: OpenAI, model: string, prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const r = await client.responses.create({ model, input: prompt, max_output_tokens: 1200, store: false });
  return { text: r.output_text, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 };
}

async function main() {
  const opts = args();
  const dataset = JSON.parse(await readFile("eval/intelligence/dataset.json", "utf8")) as { cases: Case[] };
  const cases = opts.limit ? dataset.cases.slice(0, opts.limit) : dataset.cases;
  const p = provider();
  const live = opts.live && p.name === "openai" ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  if (opts.live && !live) console.warn("--live needs OPTIMISER_PROVIDER=openai and OPENAI_API_KEY; task runs are skipped.");
  const price = INPUT_PER_MILLION[opts.model] ?? 0;

  const results: Array<{ id: string; expected_category: string; category: string; category_correct: boolean; missing_recall: number; heuristic_score: number; modes: Record<string, unknown>; user_feedback: null | "helpful" | "unhelpful" }> = [];
  for (const c of cases) {
    const classification = classifyByRules(c.prompt);
    const score = scorePrompt(c.prompt, classification.primary, classification.missing_information);
    const foundMissing = c.expected_missing.filter((k) => classification.missing_information.some((m) => m.key === k));
    const modes: Record<string, unknown> = {};
    for (const mode of MODES) {
      const r = await reviseText({ text: c.prompt, mode, classification, targetModel: opts.model, provider: p, preferences: {}, requestId: `eval-${c.id}`, userKey: "eval" });
      const kept = c.must_preserve.filter((s) => r.revised_prompt.toLowerCase().includes(s.toLowerCase()));
      const tokens = compareTokenCounts(c.prompt, r.revised_prompt, opts.model);
      const entry: Record<string, unknown> = {
        engine: r.engine,
        preservation_status: r.report.status,
        requirement_coverage: c.must_preserve.length ? kept.length / c.must_preserve.length : 1,
        lost: c.must_preserve.filter((s) => !kept.includes(s)),
        tokens_before: tokens.original.token_count,
        tokens_after: tokens.optimised.token_count,
        tokens_saved: tokens.tokens_saved,
        reduction_percent: tokens.reduction_percent,
        input_cost_before_usd: (tokens.original.token_count * price) / 1e6,
        input_cost_after_usd: (tokens.optimised.token_count * price) / 1e6,
        revised_prompt: r.revised_prompt,
      };
      if (live && c.output_checks.length && mode !== "detailed") {
        const [before, after] = [await runTask(live, opts.model, c.prompt), await runTask(live, opts.model, r.revised_prompt)];
        entry.task = {
          original_success: c.output_checks.every((x) => check(before.text, x)),
          improved_success: c.output_checks.every((x) => check(after.text, x)),
          original_usage: { input: before.inputTokens, output: before.outputTokens },
          improved_usage: { input: after.inputTokens, output: after.outputTokens },
        };
      }
      modes[mode] = entry;
    }
    results.push({
      id: c.id,
      expected_category: c.category,
      category: classification.primary,
      category_correct: classification.primary === c.category,
      missing_recall: c.expected_missing.length ? foundMissing.length / c.expected_missing.length : 1,
      heuristic_score: score.overall,
      modes,
      user_feedback: null,
    });
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const per = (mode: string, key: string) => results.map((r) => Number((r.modes[mode] as Record<string, unknown>)[key]));
  const summary = {
    cases: results.length,
    classification_accuracy: mean(results.map((r) => (r.category_correct ? 1 : 0))),
    missing_information_recall: mean(results.map((r) => r.missing_recall)),
    by_mode: Object.fromEntries(
      MODES.map((m) => [
        m,
        {
          requirement_coverage: mean(per(m, "requirement_coverage")),
          preservation_failed: results.filter((r) => (r.modes[m] as { preservation_status: string }).preservation_status === "failed").length,
          mean_reduction_percent: mean(per(m, "reduction_percent")),
          total_tokens_before: per(m, "tokens_before").reduce((a, b) => a + b, 0),
          total_tokens_after: per(m, "tokens_after").reduce((a, b) => a + b, 0),
        },
      ]),
    ),
    live_tasks: live ? "run" : "skipped (no live provider)",
  };

  const report = { generated_at: new Date().toISOString(), provider: p.name, model: opts.model, template_version: INTELLIGENCE_TEMPLATE_VERSION, summary, results };
  await mkdir("eval/reports", { recursive: true });
  const file = path.join("eval/reports", `${report.generated_at.replace(/[:.]/g, "-")}-intelligence.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
