import type { IntentCategory } from "./categories";
import type { Classification } from "./classifier";
import { validatePreservation, type Requirement } from "./requirements";
import { BREAKDOWN_LIMITS, type ModelBreakdown } from "./schemas";
import { clauses, clip, similarity, stem, wordCount, words } from "./text";

/**
 * Prompt breakdown: split one large prompt into a short sequence of focused,
 * self-contained prompts, and explain how to run them.
 *
 * The rule-based splitter works without a model. It splits on separate
 * deliverables ("write X, then create Y"); a single-deliverable prompt is
 * split into the stages that usually give better results for its category
 * (plan → produce → review). Model plans go through the same normalisation,
 * coverage check and repair, so every requirement of the original ends up in
 * at least one step.
 */

export const PLACEHOLDER = (n: number) => `[Paste the output of step ${n} here]`;
const PLACEHOLDER_RE = /\[Paste the (?:output|outline|answer|result)[^\]]*?step (\d+)[^\]]*\]/gi;

export type BreakdownLevel = "single" | "optional" | "recommended";

export interface BreakdownAssessment {
  level: BreakdownLevel;
  headline: string;
  reasons: string[];
  /** Separate deliverables detected, as written (clipped). */
  deliverables: string[];
}

export interface BreakdownStep {
  number: number;
  title: string;
  goal: string;
  prompt: string;
  depends_on: number[];
  expected_output: string;
  how_to_use: string;
  checks: string[];
  requirement_ids: string[];
  /** The final step that reviews all outputs against the original requirements. */
  is_review: boolean;
}

export interface BreakdownPlan {
  title: string;
  strategy: "deliverables" | "stages";
  /** Stage template used for a single-deliverable prompt. */
  family: StageFamily | null;
  shared_context: string | null;
  run_mode: "same_chat" | "new_chats";
  steps: BreakdownStep[];
  usage_advice: string[];
}

export interface CoverageItem {
  id: string;
  text: string;
  kind: Requirement["kind"];
  steps: number[];
  status: "covered" | "added";
}

// ---------------------------------------------------------------------------
// Task detection
// ---------------------------------------------------------------------------
const VERBS =
  "write|create|build|make|list|explain|summari[sz]e|compare|generate|design|draft|implement|develop|analy[sz]e|describe|give|find|plan|outline|propose|review|translate|rewrite|fix|refactor|calculate|identify|recommend|suggest|research|prepare|produce|convert|extract|classify|evaluate|compose|brainstorm|set up|deploy|test|document|estimate|forecast|map|audit|optimi[sz]e|turn|send|publish|code";
const LEAD = String.raw`(?:(?:then|next|also|finally|lastly|after that|afterwards|first(?:ly)?|second(?:ly)?|third(?:ly)?|and)[,:]?\s+)*`;
const POLITE = String.raw`(?:(?:hi|hello|hey)[,!]?\s+)?(?:(?:could|can|would|will) you\s+)?(?:please\s+|kindly\s+)?(?:i (?:would like|'d like|want|need)(?: you)? to\s+)?(?:help me\s+)?(?:also\s+)?`;
const TASK_START = new RegExp(String.raw`^(?:(?:step|part|phase|task)\s*\d+\s*[:.)-]\s*)?${LEAD}${POLITE}(${VERBS})\b`, "i");
const NOT_A_TASK_AFTER_MAKE = /^(?:\W*)(?:make|give)\s+(?:sure|it|them|this|that|the tone|each|every)\b/i;
const SPLIT_WITHIN = new RegExp(String.raw`(?:,\s*(?:and\s+)?(?:then\s+)?|;\s*|\s+and\s+(?:then\s+)?(?:also\s+)?|\s+then\s+)(?=(?:${VERBS})\b)`, "gi");
const SEQUENCE_CUE = /^(?:then|next|after that|afterwards|finally|lastly|using (?:it|that|this|the)|based on)\b/i;
const REFERS_BACK =
  /\b(?:the above|above|previous(?:ly)?|earlier|based on (?:it|that|this|the)|using (?:it|that|this|the (?:outline|draft|plan|research|results?|analysis|summary|list|code|design|findings))|from (?:it|that|this|the (?:outline|draft|plan|research|results?|analysis|summary|list|code|design|findings)))\b/i;
const PRONOUN_OBJECT = new RegExp(String.raw`^(?:${VERBS})\s+(?:it|them|this|that|these|those)\b`, "i");
const STRIP_LEAD = new RegExp(String.raw`^(?:[-*•]|\d+[.)])?\s*(?:(?:step|part|phase|task)\s*\d+\s*[:.)-]\s*)?${LEAD}${POLITE}`, "i");
const GLOBAL_KINDS = new Set<Requirement["kind"]>(["tone", "restriction"]);
const EVERYWHERE = /\b(all|every|each|throughout|everything|any of|across|overall|in general)\b/i;

interface Segment {
  text: string;
  start: number;
  end: number;
}

interface TaskGroup {
  task: Segment;
  /** Clauses after the task that refine it (format, length, values …). */
  details: Segment[];
  /** 0-based indices of earlier groups whose output this task uses. */
  uses: number[];
}

const GENERIC = new Set(["thing", "piece", "content", "something", "short", "brief", "detailed", "quick", "simple", "about", "using", "with", "that", "this", "your", "their", "them", "some", "each", "every"]);
const TRAILING_PRONOUN = /\b(?:\w+ing|about|for|of|on|into|from|to|with)\s+(?:it|them)\b/i;

/** Content nouns of a task's object, stemmed ("a 600-word blog post" → blog, post). */
function objectTerms(task: string): string[] {
  const bare = task.replace(STRIP_LEAD, "");
  const object = bare.replace(new RegExp(String.raw`^(?:${VERBS})\s+`, "i"), "").split(/\s(?:about|for|on|to|that|which|using|promoting|announcing|in|with)\s/i)[0] ?? "";
  return words(object).filter((w) => w.length > 3 && !GENERIC.has(w) && !/\d/.test(w)).map(stem);
}

/** Which earlier tasks a task builds on: "the post", "announcing it", "based on the outline". */
function usesOf(task: string, earlier: Segment[]): number[] {
  const lower = ` ${task.toLowerCase()} `;
  const named = earlier
    .map((g, j) => ({ j, terms: objectTerms(g.text) }))
    .filter(({ terms }) => terms.some((t) => new RegExp(String.raw`\b(?:the|this|that|these|those|your|my)\s+(?:[\w-]+\s+){0,2}${t}\w*\b`, "i").test(lower)))
    .map(({ j }) => j);
  if (named.length) return named;
  const bare = task.replace(STRIP_LEAD, "");
  if (PRONOUN_OBJECT.test(bare) || TRAILING_PRONOUN.test(bare) || REFERS_BACK.test(task)) {
    if (!earlier.length) return [];
    // "Then turn it into…" means the previous result; otherwise "it" is usually the main (largest) deliverable.
    if (SEQUENCE_CUE.test(task.replace(/^([-*•]|\d+[.)])\s+/, "")) || REFERS_BACK.test(task)) return [earlier.length - 1];
    let main = 0;
    earlier.forEach((g, j) => {
      if (wordCount(g.text) > wordCount(earlier[main]!.text)) main = j;
    });
    return [main];
  }
  return [];
}

function isTask(text: string): boolean {
  const t = text.replace(/^([-*•]|\d+[.)])\s+/, "");
  return TASK_START.test(t) && !NOT_A_TASK_AFTER_MAKE.test(t.replace(STRIP_LEAD, ""));
}

/** Split a clause such as "Write a post, then create 3 tweets" into its tasks. */
function splitTasks(seg: Segment): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  SPLIT_WITHIN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPLIT_WITHIN.exec(seg.text))) {
    const head = seg.text.slice(last, m.index);
    // Keep "compare and contrast" or "write and edit the post" together.
    if (wordCount(head) >= 3 && wordCount(seg.text.slice(m.index + m[0].length)) >= 3) {
      out.push({ text: head.trim(), start: seg.start + last, end: seg.start + m.index });
      last = m.index + m[0].length;
    }
  }
  out.push({ text: seg.text.slice(last).trim(), start: seg.start + last, end: seg.end });
  return out.filter((s) => s.text);
}

interface Parsed {
  context: Segment[];
  globals: Segment[];
  groups: TaskGroup[];
}

function parse(text: string, requirements: Requirement[]): Parsed {
  const parsed: Parsed = { context: [], globals: [], groups: [] };
  const kindAt = (s: Segment) => requirements.find((r) => r.start <= s.start && r.end >= s.end - 1)?.kind ?? null;
  const parts = clauses(text);
  for (const c of parts) {
    const seg = { text: c.text, start: c.start, end: c.end };
    if (!c.code && isTask(c.text)) {
      for (const t of splitTasks(seg)) {
        if (!isTask(t.text) && parsed.groups.length) {
          parsed.groups[parsed.groups.length - 1]!.details.push(t);
          continue;
        }
        parsed.groups.push({ task: t, details: [], uses: usesOf(t.text, parsed.groups.map((g) => g.task)) });
      }
      continue;
    }
    if (!parsed.groups.length) {
      parsed.context.push(seg);
      continue;
    }
    const kind = kindAt(seg);
    if (kind && GLOBAL_KINDS.has(kind) && EVERYWHERE.test(c.text)) parsed.globals.push(seg);
    else parsed.groups[parsed.groups.length - 1]!.details.push(seg);
  }
  // With several deliverables, a tone, restriction or "in every piece" rule after the last one
  // (in its own sentence) usually applies to all of them.
  if (parsed.groups.length >= 2) {
    const lastGroup = parsed.groups[parsed.groups.length - 1]!;
    while (lastGroup.details.length) {
      const tail = lastGroup.details[lastGroup.details.length - 1]!;
      const kind = kindAt(tail);
      if (!((kind && GLOBAL_KINDS.has(kind)) || EVERYWHERE.test(tail.text))) break;
      parsed.globals.unshift(lastGroup.details.pop()!);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------
export function assessBreakdown(text: string, requirements: Requirement[], classification: Classification): BreakdownAssessment {
  const { groups } = parse(text, requirements);
  const words = wordCount(text);
  const deliverables = groups.map((g) => clip(g.task.text.replace(STRIP_LEAD, ""), 80));
  const reasons: string[] = [];
  if (groups.length >= 2) reasons.push(`It asks for ${groups.length} separate things, and assistants often rush or skip one when they come in a single request.`);
  if (groups.some((g) => g.uses.length)) reasons.push("Later parts build on earlier ones, so checking each result before the next one stops mistakes carrying forward.");
  if (words > 250) reasons.push(`It is long (${words.toLocaleString("en")} words), and details near the middle of a long request are the easiest to miss.`);
  if (requirements.length >= 8) reasons.push(`It has ${requirements.length} requirements to satisfy at once.`);
  if (classification.secondary) reasons.push("It mixes two kinds of work, which are easier to get right one at a time.");

  const softwareBuild = classification.primary === "software_development" && words >= 25 && /\b(build|develop|implement|create|make)\b/i.test(text);
  if (softwareBuild && groups.length < 2) reasons.push("Software built in one go tends to come back untested. Agreeing on the approach first catches misunderstandings before any code is written.");
  const level: BreakdownLevel =
    groups.length >= 3 || (groups.length >= 2 && (words > 120 || requirements.length >= 6)) || words > 350 || requirements.length >= 12
      ? "recommended"
      : groups.length === 2 || words > 120 || requirements.length >= 6 || softwareBuild
        ? "optional"
        : "single";
  const headline =
    level === "recommended"
      ? "Splitting this into smaller prompts will likely give you a better result."
      : level === "optional"
        ? "This prompt can work as one request, but splitting it gives you a checkpoint between stages."
        : "This prompt is focused enough to run as one request. Splitting is optional.";
  if (level === "single") reasons.splice(0, reasons.length, "It has one clear deliverable and few requirements.");
  return { level, headline, reasons, deliverables };
}

// ---------------------------------------------------------------------------
// Rule-based plan
// ---------------------------------------------------------------------------
const bullets = (items: string[]) => items.map((i) => `- ${i.replace(/^([-*•]|\d+[.)])\s+/, "")}`).join("\n");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function titleFor(task: string): string {
  const bare = task.replace(STRIP_LEAD, "").replace(/[.:;!?]+$/, "");
  const tokens = bare.split(/\s+/);
  // Cut before the first "about / for / that …" once the title has a verb and an object.
  const cutAt = tokens.findIndex((w, i) => i >= 3 && /^(about|for|on|to|that|which|with|promoting|announcing|using|in|so|and|because)$/i.test(w));
  const head = tokens.slice(0, cutAt > 0 ? cutAt : 8).join(" ");
  return cap(clip(head, 60));
}
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function expectedFor(task: string): string {
  const bare = task.replace(STRIP_LEAD, "").replace(/[.:;!?]+$/, "");
  const m = bare.match(new RegExp(String.raw`^(?:${VERBS})\s+(?:me\s+|us\s+)?(.+)$`, "i"));
  const object = m?.[1]?.trim();
  return object && wordCount(object) >= 2 ? `${cap(clip(object, 140))}.` : "The result of this step.";
}

type StageFamily = "short" | "writing" | "software" | "research" | "planning" | "general";

interface StageSpec {
  title: string;
  goal: string;
  expected: string;
  body: (o: StageInput) => string;
  check: string;
}
interface StageInput {
  original: string;
  requirements: string[];
}

const quote = (s: string) => `"""\n${s.trim()}\n"""`;
const reqBlock = (reqs: string[], heading = "Requirements (all must be met)") => (reqs.length ? `\n\n${heading}:\n${bullets(reqs)}` : "");

const STAGES: Record<StageFamily, StageSpec[]> = {
  short: [
    {
      title: "Get a few options",
      goal: "See different directions before settling on one.",
      expected: "Three distinct options to choose from.",
      body: (o) => `${o.original.trim()}\n\nGive me 3 distinct options that take different approaches, so I can pick a direction.`,
      check: "Is one option close to what you want? Note what you like about it.",
    },
    {
      title: "Refine your favourite",
      goal: "Polish the option you picked.",
      expected: "The final, polished version.",
      body: (o) => `Here is the option I like best (keep only that one):\n\n${PLACEHOLDER(1)}\n\nImprove it while keeping what works. Return only the final version.${reqBlock(o.requirements)}`,
      check: "Is it better than the original option, and still what you asked for?",
    },
  ],
  writing: [
    {
      title: "Plan the outline",
      goal: "Agree on structure and key points before any drafting.",
      expected: "An outline with the main sections in order, the key message, and questions for you.",
      body: (o) => `I need you to write the following:\n${quote(o.original)}\n\nDon't write it yet. First give me an outline: the sections or main points in order, the key message, and how each requirement will be met. List anything you need me to confirm.`,
      check: "Does the outline cover every requirement, in an order that makes sense?",
    },
    {
      title: "Write the full draft",
      goal: "Write the complete piece from the approved outline.",
      expected: "The complete first draft.",
      body: (o) => `Write the full piece using this outline:\n\n${PLACEHOLDER(1)}${reqBlock(o.requirements)}`,
      check: "Is it complete, and does it follow the outline?",
    },
    {
      title: "Edit and check",
      goal: "Check the draft against every requirement, fix gaps, then tighten.",
      expected: "The final version and a short list of what changed.",
      body: (o) => `Review this draft against the checklist below. Fix anything that doesn't meet a requirement, then tighten the wording without changing the meaning. Return the final version, then a short list of what you changed.\n\nDraft:\n${PLACEHOLDER(2)}${reqBlock(o.requirements, "Checklist")}`,
      check: "Is every checklist item met in the final version?",
    },
  ],
  software: [
    {
      title: "Agree on the approach",
      goal: "Settle the design before any code is written.",
      expected: "A plan: components or files, data model, key functions, libraries, edge cases, and open questions.",
      body: (o) => `I need you to build the following:\n${quote(o.original)}\n\nDon't write the implementation yet. First describe your plan: the components or files, the data model, key functions, libraries you would use, and the edge cases to handle. List your assumptions and any questions for me.`,
      check: "Does the plan handle every requirement? Are its assumptions acceptable to you?",
    },
    {
      title: "Implement it",
      goal: "Write the code following the agreed plan.",
      expected: "Working code, file by file, with brief notes on how to run it.",
      body: (o) => `Implement it following this plan:\n\n${PLACEHOLDER(1)}${reqBlock(o.requirements)}\n\nGive complete code for each file and a short note on how to run it.`,
      check: "Does the code run? Does it follow the plan?",
    },
    {
      title: "Test and review",
      goal: "Test the code against the requirements and fix problems.",
      expected: "Tests, a list of issues found, and the corrected code.",
      body: (o) => `Write tests for the code below that cover each requirement and the edge cases. Then review it for bugs, security issues and anything that doesn't meet the requirements, and give corrected code for whatever needs fixing.\n\nCode:\n${PLACEHOLDER(2)}${reqBlock(o.requirements, "Requirements to test")}`,
      check: "Do the tests pass and cover every requirement?",
    },
  ],
  research: [
    {
      title: "Define scope and questions",
      goal: "Decide what exactly to find out, and how.",
      expected: "The key questions, the sources or data to use, and how findings will be judged.",
      body: (o) => `I need help with the following:\n${quote(o.original)}\n\nDon't answer it yet. First list the specific questions to answer, the sources or data you would use, and how you will judge what is reliable. Flag anything you need from me.`,
      check: "Would answering these questions fully meet the request?",
    },
    {
      title: "Research and analyse",
      goal: "Answer each question with evidence.",
      expected: "Findings for each question, with evidence and confidence.",
      body: (o) => `Answer each of these questions with evidence, and say how confident you are in each answer:\n\n${PLACEHOLDER(1)}${reqBlock(o.requirements)}`,
      check: "Is each finding supported, and is uncertainty stated?",
    },
    {
      title: "Write up the findings",
      goal: "Turn the analysis into the final deliverable.",
      expected: "The final write-up in the requested format.",
      body: (o) => `Turn these findings into the final deliverable. Keep every claim tied to its evidence, and leave out anything that isn't supported.\n\nFindings:\n${PLACEHOLDER(2)}${reqBlock(o.requirements)}`,
      check: "Is every requirement met, including format and length?",
    },
  ],
  planning: [
    {
      title: "Set goals and constraints",
      goal: "Agree on goals, constraints and success measures first.",
      expected: "Goals, constraints, success measures and open questions.",
      body: (o) => `I need a plan for the following:\n${quote(o.original)}\n\nDon't write the plan yet. First list the goals, the constraints (time, budget, people), how we will measure success, and any questions for me.`,
      check: "Are the goals and constraints right?",
    },
    {
      title: "Draft the plan",
      goal: "Write the plan within the agreed goals and constraints.",
      expected: "The plan with phases, owners, dates and deliverables.",
      body: (o) => `Draft the plan within these goals and constraints:\n\n${PLACEHOLDER(1)}${reqBlock(o.requirements)}`,
      check: "Does every phase have an owner, a date and a deliverable?",
    },
    {
      title: "Check risks and refine",
      goal: "Stress-test the plan and fix weak spots.",
      expected: "Risks with mitigations, and the revised plan.",
      body: (o) => `Review this plan: list the main risks and dependencies with a mitigation for each, check it against the requirements below, then give the revised plan.\n\nPlan:\n${PLACEHOLDER(2)}${reqBlock(o.requirements, "Checklist")}`,
      check: "Are the risks realistic, and is every requirement met?",
    },
  ],
  general: [
    {
      title: "Plan the approach",
      goal: "Agree on how to tackle it before producing the result.",
      expected: "A short plan and any questions.",
      body: (o) => `I need the following:\n${quote(o.original)}\n\nDon't do it yet. First outline how you will approach it, the steps or parts of the answer, and anything you need me to clarify.`,
      check: "Would this plan meet every requirement?",
    },
    {
      title: "Produce the result",
      goal: "Do the work following the agreed plan.",
      expected: "The complete result.",
      body: (o) => `Now do it, following this plan:\n\n${PLACEHOLDER(1)}${reqBlock(o.requirements)}`,
      check: "Is the result complete?",
    },
    {
      title: "Review and refine",
      goal: "Check the result against every requirement and improve it.",
      expected: "The final version and what changed.",
      body: (o) => `Check this result against the checklist below, fix anything that falls short, and return the final version with a short list of changes.\n\nResult:\n${PLACEHOLDER(2)}${reqBlock(o.requirements, "Checklist")}`,
      check: "Is every checklist item met?",
    },
  ],
};

function stageFamily(category: IntentCategory): Exclude<keyof typeof STAGES, "short"> {
  switch (category) {
    case "writing_communication":
    case "marketing_seo":
    case "creative_ideation":
      return "writing";
    case "software_development":
      return "software";
    case "research_analysis":
    case "data_analysis":
    case "business_strategy":
    case "education_tutoring":
      return "research";
    case "project_planning":
      return "planning";
    default:
      return "general";
  }
}

function dependencyNote(deps: number[], isFirst: boolean): string {
  if (deps.length === 0) return isFirst ? "Start here." : "Doesn't depend on another step, so you can run it in any order, or in its own chat.";
  const list = deps.map((d) => `step ${d}`).join(" and ");
  return `Run after ${list}. Paste ${deps.length > 1 ? "their answers" : "its answer"} where the prompt says [Paste…].`;
}

export function ruleBreakdown(text: string, requirements: Requirement[], classification: Classification): BreakdownPlan {
  const parsed = parse(text, requirements);
  const objective = classification.objective || clip(text, 80);
  const contextText = parsed.context.map((s) => s.text).join(" ").trim();
  const globals = parsed.globals.map((s) => s.text);
  const inSegments = (segs: Segment[]) => requirements.filter((r) => segs.some((s) => r.start < s.end && r.end > s.start)).map((r) => r.id);
  const sharedIds = inSegments([...parsed.context, ...parsed.globals]);

  let steps: BreakdownStep[];
  let strategy: BreakdownPlan["strategy"];
  let family: StageFamily | null = null;

  if (parsed.groups.length >= 2) {
    strategy = "deliverables";
    let groups = parsed.groups;
    // Bounded: merge the shortest neighbours until the plan fits (one slot is kept for the review step).
    while (groups.length > BREAKDOWN_LIMITS.maxSteps - 1) {
      let best = 0;
      for (let i = 1; i < groups.length - 1; i++) {
        if (wordCount(groups[i]!.task.text) + wordCount(groups[i + 1]!.task.text) < wordCount(groups[best]!.task.text) + wordCount(groups[best + 1]!.task.text)) best = i;
      }
      const [a, b] = [groups[best]!, groups[best + 1]!];
      groups = [...groups.slice(0, best), { task: { text: `${a.task.text} ${b.task.text}`, start: a.task.start, end: b.task.end }, details: [...a.details, ...b.details], uses: a.uses.filter((u) => u < best) }, ...groups.slice(best + 2)];
    }
    const total = groups.length;
    const others = (i: number, deps: number[]) => groups.filter((_, j) => j !== i && !deps.includes(j + 1)).map((g) => lowerFirst(titleFor(g.task.text)));
    steps = groups.map((g, i) => {
      const deps = [...new Set(g.uses.filter((u) => u < i).map((u) => u + 1))].sort((a, b) => a - b);
      const details = g.details.map((d) => d.text);
      const parts = [
        contextText ? `Context:\n${contextText}` : "",
        `Task (part ${i + 1} of ${total}):\n${cap(g.task.text)}${details.length ? `\n${details.join("\n")}` : ""}`,
        globals.length ? `Apply throughout:\n${bullets(globals)}` : "",
        ...deps.map((d) => `Build on the result of step ${d} (${lowerFirst(titleFor(groups[d - 1]!.task.text))}):\n${PLACEHOLDER(d)}`),
        `Only do this part. ${others(i, deps).length ? `The other parts (${clip(others(i, deps).join("; "), 160)}) are handled separately.` : ""}`.trim(),
      ];
      const ids = [...new Set([...inSegments([g.task, ...g.details]), ...sharedIds])];
      return {
        number: i + 1,
        title: titleFor(g.task.text),
        goal: cap(clip(g.task.text.replace(STRIP_LEAD, ""), 200)),
        prompt: parts.filter(Boolean).join("\n\n"),
        depends_on: deps,
        expected_output: expectedFor(g.task.text),
        how_to_use: dependencyNote(deps, i === 0),
        checks: [`Fully does: ${clip(g.task.text.replace(STRIP_LEAD, "").replace(/[.]+$/, ""), 140)}`, ...[...details, ...globals].slice(0, 5).map((d) => `Meets: ${clip(d.replace(/^([-*•]|\d+[.)])\s+/, ""), 160)}`)],
        requirement_ids: ids,
        is_review: false,
      };
    });
  } else {
    strategy = "stages";
    const short = wordCount(text) < 30 && requirements.length <= 3;
    family = short ? "short" : stageFamily(classification.primary);
    // The prompt's own wording of everything after the main instruction, so nothing is paraphrased away.
    const following = [...(parsed.groups[0]?.details ?? []), ...parsed.globals].map((d) => d.text);
    const reqTexts = parsed.groups.length ? following : requirements.filter((r) => r.kind !== "objective").map((r) => r.text);
    const input: StageInput = { original: text, requirements: reqTexts };
    const allIds = requirements.map((r) => r.id);
    // Later stages restate the goal so each still makes sense in a fresh chat.
    const goal = requirements.find((r) => r.kind === "objective")?.text ?? objective;
    steps = STAGES[family].map((s, i) => ({
      number: i + 1,
      title: s.title,
      goal: s.goal,
      prompt: i === 0 ? s.body(input) : `Goal: ${short ? text.trim() : goal}\n\n${s.body(input)}`,
      depends_on: i === 0 ? [] : [i],
      expected_output: s.expected,
      how_to_use: i === 0 ? "Start here. Read the answer and correct anything that's off before you continue: changes are cheapest now." : dependencyNote([i], false),
      checks: [s.check],
      requirement_ids: i === 0 ? allIds : allIds.filter((id) => requirements.find((r) => r.id === id)?.kind !== "objective"),
      is_review: false,
    }));
  }

  // A final review step for multi-deliverable plans with enough requirements to be worth checking.
  if (strategy === "deliverables" && requirements.length >= 4) {
    steps.push(reviewStep(steps, requirements));
  }

  const plan: BreakdownPlan = {
    title: planTitle(parsed.groups.map((g) => titleFor(g.task.text)), objective),
    strategy,
    family,
    shared_context: contextText || null,
    run_mode: steps.some((s) => s.depends_on.length) ? "same_chat" : "new_chats",
    steps,
    usage_advice: [],
  };
  plan.usage_advice = adviceFor(plan, classification.primary);
  return plan;
}

/** "Write a blog post, create 5 captions and draft an email", or the main task. */
function planTitle(tasks: string[], objective: string): string {
  if (!tasks.length) return clip(objective.replace(/[.!?]+$/, ""), 80);
  const parts = tasks.map((t, i) => (i === 0 ? t : lowerFirst(t)));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return joined.length <= 90 ? joined : `${parts[0]} and ${parts.length - 1} more`;
}

function reviewStep(steps: BreakdownStep[], requirements: Requirement[]): BreakdownStep {
  const n = steps.length + 1;
  const inputs = steps.map((s) => `Output of step ${s.number} (${s.title}):\n${PLACEHOLDER(s.number)}`).join("\n\n");
  return {
    number: n,
    title: "Check everything against your requirements",
    goal: "Make sure the combined result meets every requirement of the original request.",
    prompt: `Here are the results of the earlier steps:\n\n${inputs}\n\nCheck them against this checklist. For each item, say whether it is met. Then fix anything that isn't and return the corrected versions.\n\nChecklist:\n${bullets(requirements.map((r) => r.text))}`,
    depends_on: steps.map((s) => s.number),
    expected_output: "A met / not-met list for every requirement, and corrected versions where needed.",
    how_to_use: "Run last, after all other steps. Paste each step's answer where marked. If you ran everything in one chat, you can replace the pasted blocks with “the answers above”.",
    checks: ["Every checklist item is marked met."],
    requirement_ids: requirements.map((r) => r.id),
    is_review: true,
  };
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------
const FAMILY_TIP: Record<Exclude<keyof typeof STAGES, "short">, string> = {
  writing: "Approve or adjust the outline before asking for the draft. Fixing structure later means rewriting.",
  software: "Run the code from the implementation step yourself before asking for tests, and paste any errors back in that step.",
  research: "Ask for sources in the research step if you will cite anything, and check one or two of them yourself.",
  planning: "Share the goals and constraints with the people affected before drafting the plan.",
  general: "Treat the first answer as a draft. Say what to change before moving on.",
};

/** Levels: steps with no dependencies are level 1; others are one more than their deepest dependency. */
export function stepLevels(steps: Array<{ number: number; depends_on: number[] }>): Map<number, number> {
  const level = new Map<number, number>();
  for (const s of steps) level.set(s.number, 1 + Math.max(0, ...s.depends_on.map((d) => level.get(d) ?? 0)));
  return level;
}

export function adviceFor(plan: Pick<BreakdownPlan, "steps" | "run_mode" | "shared_context" | "strategy" | "family">, category: IntentCategory): string[] {
  const steps = plan.steps;
  const levels = stepLevels(steps);
  const byLevel = new Map<number, number[]>();
  for (const [n, l] of levels) byLevel.set(l, [...(byLevel.get(l) ?? []), n]);
  const parallel = [...byLevel.values()].filter((g) => g.length > 1);
  const advice: string[] = [];
  const order = [...byLevel.keys()].sort((a, b) => a - b).map((l) => (byLevel.get(l)!.length > 1 ? `(${byLevel.get(l)!.join(" + ")})` : String(byLevel.get(l)![0]))).join(" → ");
  advice.push(`Run the steps in this order: ${order}.${parallel.length ? ` Steps ${parallel.map((g) => g.join(" and ")).join("; ")} don't depend on each other, so run them in any order or at the same time.` : ""}`);
  advice.push(
    plan.run_mode === "same_chat"
      ? "Easiest: run them one after another in the same chat, so the assistant can see its earlier answers. In a new chat, paste the earlier answer where a prompt says [Paste the output of step N here]."
      : "Each step is self-contained. Start a new chat for each one to keep the answers focused.",
  );
  advice.push("Read each answer before moving on and use the checks under that step. If something is off, reply in that step with what to change, and only continue when you're happy with it. Mistakes carried forward get harder to fix.");
  if (plan.shared_context && steps.length > 1) advice.push("Each step repeats your background so it also works in a fresh chat. If you run all steps in one chat, you can delete the Context block from the later steps.");
  if (steps.some((s) => s.is_review)) advice.push("The last step checks everything against your original requirements. Don't skip it: it catches anything the other steps missed.");
  if (plan.family === "short") advice.push("In step 2, say what you liked about the option you picked. It steers the refinement better than “make it better”.");
  else if (plan.strategy === "stages") advice.push(FAMILY_TIP[plan.family ?? stageFamily(category)]);
  else {
    const foundations = steps.filter((s) => !s.is_review && steps.filter((t) => !t.is_review && t.depends_on.includes(s.number)).length >= 1).map((s) => s.number);
    if (foundations.length) advice.push(`Get step ${foundations.join(" and ")} right before moving on: other steps build on ${foundations.length > 1 ? "them" : "it"}.`);
  }
  return advice;
}

// ---------------------------------------------------------------------------
// Normalising model plans and checking coverage
// ---------------------------------------------------------------------------
/** Turn a validated model plan into a BreakdownPlan with consistent placeholders and dependencies. */
export function fromModel(m: ModelBreakdown, requirements: Requirement[], category: IntentCategory): BreakdownPlan {
  const known = new Set(requirements.map((r) => r.id));
  const steps: BreakdownStep[] = m.steps.map((s, i) => {
    const number = i + 1;
    let prompt = s.prompt.replace(PLACEHOLDER_RE, (_all, n: string) => (Number(n) >= 1 && Number(n) < number ? PLACEHOLDER(Number(n)) : _all));
    const referenced = [...prompt.matchAll(/\[Paste the output of step (\d+) here\]/g)].map((x) => Number(x[1])).filter((n) => n >= 1 && n < number);
    const deps = [...new Set([...s.depends_on, ...referenced])].filter((d) => d >= 1 && d < number).sort((a, b) => a - b);
    for (const d of deps) if (!prompt.includes(PLACEHOLDER(d))) prompt += `\n\nOutput of step ${d}:\n${PLACEHOLDER(d)}`;
    // Steps must work in a fresh chat: make sure the shared background is in each prompt.
    if (m.shared_context && !prompt.includes(m.shared_context.slice(0, 60)) && similarity(m.shared_context, prompt) < 0.2) prompt = `Context:\n${m.shared_context}\n\n${prompt}`;
    return {
      number,
      title: s.title,
      goal: s.goal,
      prompt,
      depends_on: deps,
      expected_output: s.expected_output || "The result of this step.",
      how_to_use: s.how_to_use || dependencyNote(deps, number === 1),
      checks: s.checks,
      requirement_ids: s.requirement_ids.filter((id) => known.has(id)),
      is_review: false,
    };
  });
  const last = steps[steps.length - 1];
  if (last && steps.length > 2 && last.depends_on.length >= Math.min(2, steps.length - 1) && /\b(check|review|verify|audit|qa|combine|final)\b/i.test(last.title)) last.is_review = true;
  const plan: BreakdownPlan = { title: m.title, strategy: "deliverables", family: null, shared_context: m.shared_context, run_mode: m.run_mode, steps, usage_advice: [] };
  const standard = adviceFor(plan, category);
  plan.usage_advice = [...m.usage_advice];
  for (const a of standard) if (plan.usage_advice.length < 8 && !plan.usage_advice.some((x) => similarity(x, a) >= 0.35)) plan.usage_advice.push(a);
  return plan;
}

/**
 * Which steps carry each requirement. A requirement no production step carries
 * is added to the most similar step under "Also make sure:", so nothing from
 * the original is lost. The review step's checklist does not count as coverage.
 */
export async function ensureCoverage(original: string, plan: BreakdownPlan, requirements: Requirement[]): Promise<CoverageItem[]> {
  const producers = plan.steps.filter((s) => !s.is_review);
  const shared = plan.shared_context ?? "";
  const carried = new Map<string, Set<number>>();
  for (const s of producers) {
    const report = await validatePreservation(original, `${shared}\n\n${s.prompt}`, { requirements });
    for (const c of report.checks) {
      if (c.status === "preserved" || (c.status === "changed" && s.requirement_ids.includes(c.id))) {
        carried.set(c.id, (carried.get(c.id) ?? new Set()).add(s.number));
      }
    }
  }
  const added = new Map<number, string[]>();
  const items: CoverageItem[] = requirements.map((r) => {
    const steps = [...(carried.get(r.id) ?? [])].sort((a, b) => a - b);
    if (steps.length) return { id: r.id, text: r.text, kind: r.kind, steps, status: "covered" as const };
    // Tone, restrictions and "in every piece" rules apply to every step; anything else goes to the closest step.
    const everywhere = producers.length > 1 && (GLOBAL_KINDS.has(r.kind) || EVERYWHERE.test(r.text));
    const targets = everywhere ? producers : [producers.reduce((best, s) => (similarity(r.text, s.prompt) > similarity(r.text, best.prompt) ? s : best), producers[producers.length - 1]!)];
    for (const t of targets) added.set(t.number, [...(added.get(t.number) ?? []), r.text]);
    return { id: r.id, text: r.text, kind: r.kind, steps: targets.map((t) => t.number), status: "added" as const };
  });
  for (const [n, texts] of added) {
    const step = plan.steps.find((s) => s.number === n)!;
    step.prompt = `${step.prompt}\n\nAlso make sure:\n${bullets(texts)}`;
    step.requirement_ids = [...new Set([...step.requirement_ids, ...items.filter((i) => i.status === "added" && i.steps.includes(n)).map((i) => i.id)])];
  }
  for (const s of producers) s.requirement_ids = [...new Set([...s.requirement_ids, ...items.filter((i) => i.steps.includes(s.number)).map((i) => i.id)])];
  return items;
}

/** The plan as the model-output shape, used by the rule-based provider. */
export function toModelShape(plan: BreakdownPlan): ModelBreakdown {
  return {
    title: plan.title,
    shared_context: plan.shared_context,
    run_mode: plan.run_mode,
    steps: plan.steps.map((s) => ({ title: s.title, goal: s.goal, prompt: s.prompt, depends_on: s.depends_on, expected_output: s.expected_output, how_to_use: s.how_to_use, checks: s.checks, requirement_ids: s.requirement_ids })),
    usage_advice: plan.usage_advice,
  };
}

/** The whole plan as Markdown, for copying or downloading. */
export function planToMarkdown(plan: { title: string; usage_advice: string[]; steps: Array<{ number: number; title: string; prompt: string; expected_output: string; how_to_use: string; checks: string[] }> }): string {
  const lines = [`# ${plan.title}`, "", "## How to use these prompts", "", ...plan.usage_advice.map((a) => `- ${a}`), ""];
  for (const s of plan.steps) {
    lines.push(`## Step ${s.number}: ${s.title}`, "", `**How to use:** ${s.how_to_use}`, "", `**Expect:** ${s.expected_output}`, "", "```text", s.prompt, "```", "");
    if (s.checks.length) lines.push("**Check before continuing:**", "", ...s.checks.map((c) => `- [ ] ${c}`), "");
  }
  return lines.join("\n");
}
