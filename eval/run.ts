/**
 * Evaluation harness (SRS §13.3, PIQ-018).
 *
 *   npm run eval                       # provider from OPTIMISER_PROVIDER (mock by default)
 *   OPTIMISER_PROVIDER=openai npm run eval -- --limit 5
 *   npm run eval -- --baseline eval/reports/2026-10-30T10-00-00-piq-optimiser-v1.json
 *
 * Runs every case in eval/dataset.jsonl through the optimiser and applies
 * deterministic invariants: schema validity, identifiers preserved, no invented
 * URLs, category agreement, instruction-override attempts flagged. Writes a JSON
 * report with per-case results and token/latency measures. Human review and a
 * model-based judge are deliberately separate signals (§13.3): the report has a
 * `review` slot per case for graders.
 */
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { TEMPLATE_VERSION } from "../src/lib/optimiser/instructions";
import { MockOptimiserProvider } from "../src/lib/providers/mock";
import { OpenAIOptimiserProvider } from "../src/lib/providers/openai";
import type { OptimiserProvider } from "../src/lib/providers/types";
import { estimateTokens } from "../src/lib/tokens";
import type { TaskCategory } from "../src/lib/categories";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

interface EvalCase {
  id: string;
  category: TaskCategory;
  prompt: string;
  must_contain: string[];
  must_not_match?: string[];
  case_insensitive?: boolean;
  expect_clarification?: boolean;
  expect_language?: string;
  adversarial?: boolean;
  notes?: string;
}

interface CaseResult {
  id: string;
  category: TaskCategory;
  status: "pass" | "fail" | "error";
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  tokens_before: number;
  tokens_after: number;
  latency_ms: number;
  returned_category?: string;
  clarification_needed?: boolean;
  change_summary?: string[];
  quality_risks?: string[];
  optimised_prompt?: string;
  error?: string;
  /** Filled in by a human grader: intent_preserved, clarity (1–5), notes. */
  review: { intent_preserved: boolean | null; clarity: number | null; notes: string };
}

const URL_RE = /https?:\/\/[^\s)]+/g;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { limit: Number(get("--limit") ?? "0") || 0, baseline: get("--baseline"), only: get("--only") };
}

function makeProvider(): OptimiserProvider {
  if (process.env.OPTIMISER_PROVIDER === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for OPTIMISER_PROVIDER=openai");
    const effort = process.env.OPTIMISER_REASONING_EFFORT as "low" | "medium" | "high" | "minimal" | "none" | undefined;
    return new OpenAIOptimiserProvider({
      apiKey,
      modelId: process.env.OPTIMISER_MODEL ?? "gpt-5-mini",
      timeoutMs: Number(process.env.OPTIMISER_TIMEOUT_MS ?? "30000"),
      reasoningEffort: effort || undefined,
    });
  }
  return new MockOptimiserProvider();
}

async function runCase(provider: OptimiserProvider, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const base: Omit<CaseResult, "status" | "checks" | "latency_ms"> = {
    id: c.id,
    category: c.category,
    tokens_before: estimateTokens(c.prompt).tokens,
    tokens_after: 0,
    review: { intent_preserved: null, clarity: null, notes: "" },
  };
  try {
    const result = await provider.optimise({
      prompt: c.prompt,
      taskCategory: "auto",
      preferences: {},
      maxOutputTokens: 1500,
      requestId: `eval-${c.id}`,
      userKey: "eval",
    });
    const latency = Date.now() - started;
    if (result.kind !== "ok") {
      return { ...base, status: "fail", latency_ms: latency, checks: [{ name: "provider_ok", ok: false, detail: `${result.kind}: ${result.reason}` }] };
    }
    const out = result.output;
    const text = out.optimised_prompt;
    const norm = (s: string) => (c.case_insensitive ? s.toLowerCase() : s);
    const checks: CaseResult["checks"] = [];

    for (const needle of c.must_contain) {
      checks.push({ name: `preserves:${needle}`, ok: norm(text).includes(norm(needle)) });
    }
    for (const pattern of c.must_not_match ?? []) {
      checks.push({ name: `absent:${pattern}`, ok: !new RegExp(pattern, "m").test(text) });
    }
    const inputUrls = new Set(c.prompt.match(URL_RE) ?? []);
    const newUrls = (text.match(URL_RE) ?? []).filter((u) => !inputUrls.has(u));
    checks.push({ name: "no_invented_urls", ok: newUrls.length === 0, detail: newUrls.join(", ") || undefined });
    checks.push({ name: "category_agrees", ok: out.task_category === c.category, detail: out.task_category });
    checks.push({ name: "has_change_summary", ok: out.change_summary.length > 0 });
    if (c.expect_clarification) {
      checks.push({ name: "asks_for_clarification_or_placeholders", ok: out.clarification_needed || /\[[A-Z][A-Z _]+\]/.test(text) });
    }
    if (c.adversarial) {
      checks.push({ name: "flags_override_attempt", ok: out.quality_risks.length > 0 });
    }
    checks.push({ name: "not_self_referential", ok: !/PromptIQ|the original prompt/i.test(text) });

    const status = checks.every((k) => k.ok) ? "pass" : "fail";
    return {
      ...base,
      status,
      checks,
      latency_ms: latency,
      tokens_after: estimateTokens(text).tokens,
      returned_category: out.task_category,
      clarification_needed: out.clarification_needed,
      change_summary: out.change_summary,
      quality_risks: out.quality_risks,
      optimised_prompt: text,
    };
  } catch (error) {
    return { ...base, status: "error", latency_ms: Date.now() - started, checks: [], error: (error as Error).message };
  }
}

async function main() {
  const { limit, baseline, only } = parseArgs();
  const raw = await readFile(path.resolve("eval/dataset.jsonl"), "utf8");
  let cases = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalCase);
  if (only) cases = cases.filter((c) => c.id === only);
  if (limit) cases = cases.slice(0, limit);

  const provider = makeProvider();
  console.log(`Evaluating ${cases.length} cases with ${provider.name} (${provider.modelId}), template ${TEMPLATE_VERSION}`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(provider, c);
    results.push(r);
    const failed = r.checks.filter((k) => !k.ok).map((k) => k.name);
    console.log(`${r.status.padEnd(5)} ${r.id.padEnd(22)} ${String(r.tokens_before).padStart(4)} → ${String(r.tokens_after).padStart(4)} tokens  ${String(r.latency_ms).padStart(6)} ms${failed.length ? `  failed: ${failed.join(", ")}` : ""}${r.error ? `  error: ${r.error}` : ""}`);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const deltas = results.filter((r) => r.status !== "error").map((r) => (r.tokens_after - r.tokens_before) / Math.max(1, r.tokens_before));
  const medianDelta = deltas.length ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0 : 0;
  const p95 = [...results.map((r) => r.latency_ms)].sort((a, b) => a - b)[Math.floor(results.length * 0.95)] ?? 0;

  const summary = {
    template_version: TEMPLATE_VERSION,
    provider: provider.name,
    model_id: provider.modelId,
    generated_at: new Date().toISOString(),
    cases: results.length,
    passed,
    pass_rate: results.length ? passed / results.length : 0,
    median_token_delta: medianDelta,
    p95_latency_ms: p95,
    note: "Token deltas are tokenizer estimates. Quality must be judged by human review (review fields) before any public claim (A-10).",
  };

  console.log(`\n${passed}/${results.length} passed (${(summary.pass_rate * 100).toFixed(0)}%), median token change ${(medianDelta * 100).toFixed(0)}%, p95 latency ${p95} ms`);

  if (baseline) {
    const prev = JSON.parse(await readFile(baseline, "utf8")) as { summary: typeof summary; results: CaseResult[] };
    const regressions = prev.results.filter((p) => p.status === "pass" && results.find((r) => r.id === p.id)?.status !== "pass").map((p) => p.id);
    console.log(`\nBaseline ${prev.summary.template_version}: pass rate ${(prev.summary.pass_rate * 100).toFixed(0)}% → ${(summary.pass_rate * 100).toFixed(0)}%; regressions: ${regressions.length ? regressions.join(", ") : "none"}`);
  }

  await mkdir("eval/reports", { recursive: true });
  const file = path.join("eval/reports", `${summary.generated_at.replace(/[:.]/g, "-")}-${TEMPLATE_VERSION}.json`);
  await writeFile(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report written to ${file}`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
