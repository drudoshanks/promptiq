import { INTELLIGENCE_CONFIG } from "@/lib/config/intelligence";

import { clauses, exactValues, keyTerms, NEGATION_RE, shortHash, stem, techTerms, termSet, words } from "./text";

/**
 * Requirement extraction and preservation checks (§8). Extraction is
 * deterministic so the checklist is reproducible and testable. Requirements
 * store character offsets into the analysed text rather than copies of it.
 */
export const REQUIREMENT_KINDS = ["objective", "functional", "technical", "value", "format", "length", "tone", "restriction", "dependency", "example"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_KIND_LABELS: Record<RequirementKind, string> = {
  objective: "Objective",
  functional: "Requirement",
  technical: "Technical constraint",
  value: "Specific value",
  format: "Output format",
  length: "Length",
  tone: "Tone",
  restriction: "Restriction",
  dependency: "Condition",
  example: "Example",
};

export interface Requirement {
  id: string;
  kind: RequirementKind;
  text: string;
  start: number;
  end: number;
  essential: boolean;
  /** Stemmed content words used for the overlap check. */
  terms: string[];
  /** Values that must appear verbatim (numbers with units, quotes, URLs, technologies). */
  values: string[];
}

const RESTRICTION = /\b(don'?t|do not|never|avoid|without|must not|mustn'?t|should not|shouldn'?t|exclude|excluding|except|no more than|only|cannot|can'?t)\b|(?:^|[,;:]\s*|\band\s+)no\s+\w+/i;
export const FORMAT_CUE = /\b(json|csv|yaml|xml|table|markdown|bullet(?:ed)?|bullets|numbered|list|headings?|paragraphs?|sections?|format(?:ted)?|outline|template|code block|diagram|slides?)\b/i;
export const LENGTH_CUE = /\b\d+[\s-]*(words?|characters?|chars|sentences?|paragraphs?|pages?|bullets?|points?|items?|lines?|minutes?|slides?)\b|\b(short|brief|concise|succinct|detailed|in-depth|thorough|comprehensive|under|at most|at least|maximum|minimum|no longer than|one[- ]page)\b/i;
const TONE = /\b(tone|voice|formal|informal|casual|friendly|professional|playful|witty|neutral|persuasive|empathetic|humorous|authoritative|conversational)\b/i;
const DEPENDENCY = /\b(if|when|unless|after|before|depends on|in case|only when|provided that)\b/i;
const EXAMPLE = /\b(e\.g\.|for example|for instance|such as|like this|example:)\b|```/i;
const FUNCTIONAL = /\b(must|should|need(?:s)? to|has to|have to|include|includ(?:ing|es)|support|allow|ensure|make sure|require[sd]?|cover|mention|add|handle|provide)\b/i;
const IMPERATIVE = /^(?:[-*•]|\d+[.)])?\s*(?:(?:hi|hello|hey)[,!]?\s+)?(?:(?:could|can|would|will) you\s+)?(?:please\s+|kindly\s+)?(?:i (?:would like|'d like|want|need)(?: you)? to\s+)?(?:help me\s+)?(write|create|build|make|list|explain|summari[sz]e|compare|generate|design|draft|implement|develop|analy[sz]e|describe|give|find|plan|outline|propose|review|translate|rewrite|fix|refactor|calculate|identify|recommend|suggest|research|prepare|produce|convert|extract|classify|evaluate|help)\b/i;
const CONTEXT_ONLY = /^(?:i am|i'm|we are|we're|our|my|the company|currently|background|context)\b/i;

function kindOf(text: string, index: number): RequirementKind | null {
  // By convention the first instruction states the objective, even when it also carries length or tone cues.
  if (index === 0 && (IMPERATIVE.test(text) || !CONTEXT_ONLY.test(text))) return "objective";
  if (RESTRICTION.test(text)) return "restriction";
  if (EXAMPLE.test(text)) return "example";
  if (LENGTH_CUE.test(text)) return "length";
  if (FORMAT_CUE.test(text)) return "format";
  if (TONE.test(text)) return "tone";
  if (techTerms(text).length) return "technical";
  if (DEPENDENCY.test(text) && FUNCTIONAL.test(text)) return "dependency";
  if (FUNCTIONAL.test(text) || IMPERATIVE.test(text)) return "functional";
  if (index === 0) return "objective";
  if (exactValues(text).length) return "value";
  return null;
}

/** Extract the checklist of requirements from a prompt. */
export function extractRequirements(text: string): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const parts = clauses(text);
  parts.forEach((c, i) => {
    if (out.length >= INTELLIGENCE_CONFIG.maxRequirements) return;
    const norm = words(c.text).join(" ");
    if (seen.has(norm)) return; // a repeated instruction is one requirement
    seen.add(norm);
    if (c.code) {
      out.push({ id: `r${shortHash(`${c.start}:${c.text}`)}`, kind: "example", text: c.text, start: c.start, end: c.end, essential: true, terms: [], values: [c.text.slice(0, 60)] });
      return;
    }
    const kind = kindOf(c.text, i);
    if (!kind) return;
    if (kind !== "objective" && CONTEXT_ONLY.test(c.text) && !FUNCTIONAL.test(c.text) && !RESTRICTION.test(c.text)) return;
    const values = [...new Set([...exactValues(c.text), ...techTerms(c.text)])];
    out.push({
      id: `r${shortHash(`${c.start}:${c.text}`)}`,
      kind,
      text: c.text,
      start: c.start,
      end: c.end,
      essential: kind !== "example" || values.length > 0,
      terms: keyTerms(c.text, 10),
      values,
    });
  });
  return out;
}

export type PreservationStatus = "preserved" | "changed" | "missing" | "contradicted";
export type ValidationStatus = "passed" | "needs_review" | "failed";

export interface RequirementCheck {
  id: string;
  kind: RequirementKind;
  text: string;
  start: number;
  end: number;
  essential: boolean;
  status: PreservationStatus;
  method: "deterministic" | "semantic";
  note: string | null;
}

export interface PreservationReport {
  status: ValidationStatus;
  checks: RequirementCheck[];
  preserved: number;
  changed: number;
  missing: number;
  contradicted: number;
  new_assumptions: string[];
  contradictions: string[];
  summary: string;
  disclaimer: string;
}

export const PRESERVATION_DISCLAIMER =
  "Automated checks compare wording, values and restrictions. They catch most dropped or reversed requirements but cannot guarantee the revision means exactly the same thing; read the result before using it.";

const SYNONYMS: Record<string, string[]> = {
  short: ["brief", "concis", "succinct"],
  brief: ["short", "concis"],
  concis: ["short", "brief", "succinct"],
  explain: ["describ"],
  describ: ["explain"],
  user: ["customer", "reader"],
  customer: ["user", "client"],
  write: ["draft", "produc", "creat"],
  creat: ["build", "make", "generat", "produc"],
  build: ["creat", "implement", "develop"],
  list: ["bullet", "enumerat"],
  bullet: ["list"],
  avoid: ["not", "never", "without"],
  includ: ["cover", "contain", "add"],
};

function coverage(req: Requirement, revisedTerms: Set<string>): number {
  if (req.terms.length === 0) return 1;
  let hit = 0;
  for (const t of req.terms) {
    if (revisedTerms.has(t) || (SYNONYMS[t] ?? []).some((s) => revisedTerms.has(s))) hit += 1;
  }
  return hit / req.terms.length;
}

function valuePresent(value: string, revisedLower: string): boolean {
  const v = value.toLowerCase();
  if (revisedLower.includes(v)) return true;
  // "500 words" vs "500-word"
  const num = v.match(/^(\d[\d,.]*)\s*(\w+)?/);
  if (num?.[1] && num[2]) return new RegExp(`\\b${num[1].replace(/[.,]/g, "\\$&")}\\s*-?\\s*${stem(num[2])}`).test(revisedLower);
  return false;
}

/** Number with the same unit but a different value ("500 words" → "300 words"). */
function changedValue(value: string, revisedLower: string): string | null {
  const m = value.toLowerCase().match(/^(\d[\d,.]*)\s*([a-z%$€£]+)/);
  if (!m?.[2]) return null;
  const unit = stem(m[2]);
  const re = new RegExp(`\\b(\\d[\\d,.]*)\\s*-?\\s*${unit.replace(/[$%]/g, "\\$&")}`, "g");
  for (const found of revisedLower.matchAll(re)) {
    if (found[1] !== m[1]) return `${m[1]} ${m[2]} became ${found[1]} ${m[2]}`;
  }
  return null;
}

/** Sentences of the revised text that contain most of the requirement's terms. */
function negationFlipped(req: Requirement, revised: string): boolean {
  if (req.kind !== "restriction" || req.terms.length === 0) return false;
  const objectTerms = req.terms.filter((t) => !["avoid", "never", "without", "exclud", "only", "don't", "not"].includes(t));
  if (objectTerms.length === 0) return false;
  const relevant = clauses(revised).filter((c) => {
    const ts = termSet(c.text);
    return objectTerms.filter((t) => ts.has(t)).length / objectTerms.length >= 0.6;
  });
  return relevant.length > 0 && relevant.every((c) => !NEGATION_RE.test(c.text));
}

/** Lines the revision presents as assumptions that the original did not contain. */
export function findNewAssumptions(original: string, revised: string): string[] {
  const out: string[] = [];
  let inSection = false;
  const origTerms = termSet(original);
  for (const raw of revised.split("\n")) {
    const line = raw.trim();
    if (/^#{0,4}\s*assumptions?\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (/^#{1,4}\s|^[A-Z][\w ]{2,40}:$/.test(line)) inSection = false;
    const isAssumption = inSection ? /^([-*•]|\d+[.)])\s+/.test(line) : /^(assume|assumption:)/i.test(line);
    if (!isAssumption) continue;
    const text = line.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/^assumption:\s*/i, "");
    const terms = [...termSet(text)];
    const novel = terms.filter((t) => !origTerms.has(t)).length;
    if (text && novel > 0) out.push(text.slice(0, 240));
  }
  return out.slice(0, 12);
}

function detectContradictions(revised: string): string[] {
  const out: string[] = [];
  if (/\b(short|brief|concise)\b/i.test(revised) && /\b(detailed|in-depth|comprehensive|exhaustive)\b/i.test(revised) && !/\b(brief|short)\b[^.]*\bbut\b/i.test(revised)) {
    out.push("Asks for both a brief and a detailed answer.");
  }
  if (/\bformal\b/i.test(revised) && /\b(casual|informal|playful)\b/i.test(revised)) out.push("Asks for both a formal and a casual tone.");
  const maxW = revised.match(/\b(?:under|at most|no more than|maximum of|max)\s+(\d+)\s+words\b/i);
  const minW = revised.match(/\b(?:at least|minimum of|min)\s+(\d+)\s+words\b/i);
  if (maxW?.[1] && minW?.[1] && Number(minW[1]) > Number(maxW[1])) out.push(`Minimum length (${minW[1]} words) is above the maximum (${maxW[1]} words).`);
  return out;
}

export interface SemanticCompare {
  (items: Array<{ id: string; text: string }>, revised: string): Promise<Array<{ id: string; status: PreservationStatus; note: string | null }>>;
}

/**
 * Compare the checklist with a proposed prompt. Deterministic first (values,
 * restrictions, term coverage); an optional semantic comparison re-checks only
 * the items the deterministic pass could not confirm.
 */
export async function validatePreservation(
  original: string,
  revised: string,
  options: { requirements?: Requirement[]; semantic?: SemanticCompare | null } = {},
): Promise<PreservationReport> {
  const reqs = options.requirements ?? extractRequirements(original);
  const revisedLower = revised.toLowerCase();
  const revisedTerms = new Set(words(revised).map(stem));
  const checks: RequirementCheck[] = reqs.map((r) => {
    const base = { id: r.id, kind: r.kind, text: r.text, start: r.start, end: r.end, essential: r.essential, method: "deterministic" as const };
    const changed = r.values.map((v) => changedValue(v, revisedLower)).find(Boolean);
    const missingValues = r.values.filter((v) => !valuePresent(v, revisedLower));
    if (changed && missingValues.length) return { ...base, status: "contradicted" as const, note: `Value changed: ${changed}.` };
    if (negationFlipped(r, revised)) return { ...base, status: "contradicted" as const, note: "The restriction appears without its negation, so it may now say the opposite." };
    const cov = coverage(r, revisedTerms);
    if (missingValues.length) {
      return { ...base, status: cov >= INTELLIGENCE_CONFIG.changedOverlap ? ("changed" as const) : ("missing" as const), note: `Missing exact value${missingValues.length > 1 ? "s" : ""}: ${missingValues.slice(0, 3).join(", ")}.` };
    }
    if (cov >= INTELLIGENCE_CONFIG.preservedOverlap) return { ...base, status: "preserved" as const, note: null };
    if (cov >= INTELLIGENCE_CONFIG.changedOverlap) return { ...base, status: "changed" as const, note: "Reworded; check the meaning is the same." };
    return { ...base, status: "missing" as const, note: "Not found in the revision." };
  });

  if (options.semantic) {
    const unresolved = checks.filter((c) => c.status === "missing" || c.status === "changed");
    if (unresolved.length) {
      try {
        const verdicts = await options.semantic(unresolved.map((c) => ({ id: c.id, text: c.text })), revised);
        for (const v of verdicts) {
          const c = checks.find((x) => x.id === v.id);
          // The semantic pass may confirm or downgrade, never silently upgrade a value mismatch.
          if (!c || (c.note?.startsWith("Missing exact value") && v.status === "preserved")) continue;
          c.status = v.status;
          c.method = "semantic";
          c.note = v.note ?? (v.status === "preserved" ? "Same meaning, different wording." : c.note);
        }
      } catch {
        // Semantic comparison is best-effort; the deterministic verdict stands.
      }
    }
  }

  const count = (s: PreservationStatus) => checks.filter((c) => c.status === s).length;
  const contradictions = detectContradictions(revised).filter((c) => !detectContradictions(original).includes(c));
  const essentialLost = checks.some((c) => c.essential && (c.status === "missing" || c.status === "contradicted"));
  const status: ValidationStatus = essentialLost || contradictions.length ? "failed" : checks.some((c) => c.status !== "preserved") ? "needs_review" : "passed";
  const report: PreservationReport = {
    status,
    checks,
    preserved: count("preserved"),
    changed: count("changed"),
    missing: count("missing"),
    contradicted: count("contradicted"),
    new_assumptions: findNewAssumptions(original, revised),
    contradictions,
    summary: "",
    disclaimer: PRESERVATION_DISCLAIMER,
  };
  report.summary =
    checks.length === 0
      ? "No explicit requirements were detected in the original, so there was nothing to check."
      : status === "passed"
        ? `All ${checks.length} detected requirement${checks.length > 1 ? "s were" : " was"} found in the revision.`
        : status === "needs_review"
          ? `${report.preserved} of ${checks.length} requirements found as written; ${report.changed + report.missing} need a look.`
          : `${report.missing + report.contradicted} essential requirement${report.missing + report.contradicted === 1 ? " is" : "s are"} missing or reversed${contradictions.length ? ", and the revision contradicts itself" : ""}.`;
  return report;
}

/** Storage form of a report: statuses and offsets only, never prompt text. */
export function compactReport(report: PreservationReport) {
  return {
    status: report.status,
    counts: { preserved: report.preserved, changed: report.changed, missing: report.missing, contradicted: report.contradicted },
    checks: report.checks.map((c) => ({ id: c.id, kind: c.kind, start: c.start, end: c.end, essential: c.essential, status: c.status, method: c.method })),
    new_assumption_count: report.new_assumptions.length,
    contradiction_count: report.contradictions.length,
  };
}
