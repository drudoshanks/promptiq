import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { countTokens } from "@/lib/tokens";

import { extractRequirements, validatePreservation, type PreservationReport, type Requirement } from "./requirements";
import { normaliseSentence, similarity } from "./text";

/**
 * PromptOptimisationEngine, deterministic part (§7). Each step is a pure
 * text transform that never touches code blocks, quoted text, URLs or numbers.
 * The guarded pipeline applies one step at a time, recounts tokens, re-runs
 * the requirement check and keeps the step only if nothing essential was lost.
 */
export interface CompressionStep {
  key: string;
  label: string;
  apply: (text: string) => string;
}

const PROTECTED = /```[\s\S]*?```|"[^"\n]*"|“[^”\n]*”|https?:\/\/\S+/g;

/** Run `fn` on the unprotected parts of the text only. */
function outsideProtected(text: string, fn: (segment: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += fn(text.slice(last, m.index));
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fn(text.slice(last));
}

const FILLER: Array<[RegExp, string]> = [
  [/\b(?:please|kindly)\s+/gi, ""],
  [/\bcould you\s+(?:please\s+)?/gi, ""],
  [/\bcan you\s+(?:please\s+)?/gi, ""],
  [/\b(?:i would like|i'd like|i want|i need) you to\s+/gi, ""],
  [/\b(?:basically|actually|really|just|simply|literally)\s+/gi, ""],
  [/\bif possible,?\s*/gi, ""],
  [/\bthank you(?: so much)?(?: in advance)?[.!]?\s*/gi, ""],
  [/\bthanks[.!]?\s*/gi, ""],
  [/\b(?:hi|hello|hey)(?: there)?[,!]\s*/gi, ""],
];

const VERBOSE: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bwith regard to\b|\bwith respect to\b|\bin relation to\b/gi, "about"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bprior to\b/gi, "before"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bit is important (?:that you|to)\s+/gi, ""],
  [/\b(?:make sure|be sure|ensure) (?:that )?(?:you )?to\s+/gi, ""],
  [/\bmake sure (?:that )?/gi, "ensure "],
  [/\bplease note that\s+/gi, ""],
  [/\bit should be noted that\s+/gi, ""],
  [/\bin a (\w+) manner\b/gi, "$1ly"],
  [/\bis able to\b/gi, "can"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bat all times\b/gi, "always"],
];

const recapitalise = (s: string) => s.replace(/(^|[.!?]\s+|\n\s*(?:[-*•]\s+)?)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=\S)|\n/);
}

export const STEPS: CompressionStep[] = [
  {
    key: "dedupe",
    label: "Removed repeated or equivalent instructions",
    apply: (text) => {
      if (/```/.test(text)) return text;
      const kept: string[] = [];
      const seen: string[] = [];
      for (const line of text.split("\n")) {
        const parts = splitSentences(line).filter((p) => p.trim());
        const out: string[] = [];
        for (const p of parts) {
          const body = p.replace(/^\s*([-*•]|\d+[.)])\s+/, "");
          const key = normaliseSentence(body);
          const dup = key && seen.some((k) => normaliseSentence(k) === key || (key.split(" ").length >= 4 && similarity(k, body) >= 0.85));
          if (!dup) {
            out.push(p.trim());
            seen.push(body);
          }
        }
        if (out.length || !line.trim()) kept.push(out.join(" "));
      }
      return kept.join("\n").replace(/\n{3,}/g, "\n\n");
    },
  },
  {
    key: "filler",
    label: "Removed filler and politeness phrases",
    apply: (text) => recapitalise(outsideProtected(text, (seg) => FILLER.reduce((s, [re, to]) => s.replace(re, to), seg))),
  },
  {
    key: "verbose",
    label: "Simplified verbose wording",
    apply: (text) => recapitalise(outsideProtected(text, (seg) => VERBOSE.reduce((s, [re, to]) => s.replace(re, to), seg))),
  },
  {
    key: "merge",
    label: "Combined equivalent constraints",
    apply: (text) => {
      const lines = text.split("\n");
      const out: string[] = [];
      for (const line of lines) {
        const m = line.match(/^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/);
        const body = m?.[2];
        if (body && out.some((o) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(o) && similarity(o.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""), body) >= 0.8)) continue;
        out.push(line);
      }
      return out.join("\n");
    },
  },
  {
    key: "whitespace",
    label: "Collapsed extra whitespace",
    apply: (text) => text.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").replace(/\n{3,}/g, "\n\n").trim(),
  },
];

/** Unguarded compression (all steps). Used where no requirement check is needed. */
export function compress(text: string): { text: string; applied: string[] } {
  let out = text;
  const applied: string[] = [];
  for (const step of STEPS) {
    const next = step.apply(out);
    if (next !== out) {
      applied.push(step.label);
      out = next;
    }
  }
  return { text: out, applied };
}

export interface GuardedResult {
  text: string;
  tokens_before: number;
  tokens_after: number;
  steps: Array<{ key: string; label: string; tokens_saved: number; kept: boolean; reason?: string }>;
  report: PreservationReport;
  iterations: number;
}

/**
 * Guarded pipeline: apply each step, recount, validate against the ORIGINAL
 * requirements, revert any step that loses an essential requirement. Repeats
 * until nothing safe is left to remove or the iteration limit is reached.
 */
export async function guardedCompress(
  original: string,
  candidate: string,
  options: { modelId?: string; budget?: number | null; maxIterations?: number; requirements?: Requirement[] } = {},
): Promise<GuardedResult> {
  const modelId = options.modelId ?? DEFAULT_TARGET_MODEL;
  const tokens = (t: string) => countTokens(t, modelId).token_count;
  const reqs = options.requirements ?? extractRequirements(original);
  const lostEssential = (r: PreservationReport) => r.checks.filter((c) => c.essential && (c.status === "missing" || c.status === "contradicted")).length;

  let text = candidate;
  let report = await validatePreservation(original, text, { requirements: reqs });
  const baseline = lostEssential(report);
  const steps: GuardedResult["steps"] = [];
  const maxIterations = Math.max(1, options.maxIterations ?? 3);
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let changed = false;
    for (const step of STEPS) {
      const next = step.apply(text);
      if (next === text) continue;
      const nextReport = await validatePreservation(original, next, { requirements: reqs });
      const saved = tokens(text) - tokens(next);
      if (lostEssential(nextReport) > baseline) {
        steps.push({ key: step.key, label: step.label, tokens_saved: 0, kept: false, reason: "Reverted: it would have removed a required detail." });
        continue;
      }
      steps.push({ key: step.key, label: step.label, tokens_saved: saved, kept: true });
      text = next;
      report = nextReport;
      changed = true;
    }
    // A budget is a ceiling, not a target: keep removing waste until nothing safe is left.
    if (!changed) {
      iterations += 1;
      break;
    }
  }
  // Merge repeated step entries for display.
  const merged = new Map<string, GuardedResult["steps"][number]>();
  for (const s of steps) {
    const prev = merged.get(s.key);
    merged.set(s.key, prev ? { ...prev, tokens_saved: prev.tokens_saved + s.tokens_saved, kept: prev.kept || s.kept } : s);
  }
  return { text, tokens_before: tokens(original), tokens_after: tokens(text), steps: [...merged.values()], report, iterations };
}

/** Plain-language explanation when a token budget cannot be met safely. */
export function budgetAdvice(tokensAfter: number, budget: number, report: PreservationReport): { met: boolean; explanation: string | null; alternatives: string[] } {
  if (tokensAfter <= budget) return { met: true, explanation: null, alternatives: [] };
  const essential = report.checks.filter((c) => c.essential).length;
  return {
    met: false,
    explanation: `The shortest safe version is ${tokensAfter} tokens, ${tokensAfter - budget} over your ${budget}-token budget. Cutting further would drop some of the ${essential} essential requirement${essential === 1 ? "" : "s"}, so PromptIQ stopped here.`,
    alternatives: [
      `Raise the budget to ${Math.ceil(tokensAfter / 10) * 10} tokens.`,
      "Remove requirements you no longer need from the original, then optimise again.",
      "Move long reference material (examples, data) into a separate message or file.",
    ],
  };
}
