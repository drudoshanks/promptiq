import type { GenerationMode, SuggestionKind } from "./categories";
import type { Classification } from "./classifier";
import { compress, STEPS } from "./compress";
import type { Requirement } from "./requirements";
import { intentRepresentationSchema, type IntentRepresentation } from "./schemas";
import { templateFor, type PromptTemplate, type TemplateSection } from "./templates";
import { clauses, clip, normaliseSentence } from "./text";

/**
 * PromptStructureBuilder (§5). Builds a validated intermediate representation
 * from the prompt, then renders it with a category template. Known facts,
 * requirements, assumptions and open questions are kept apart; nothing is
 * invented — missing information becomes a question or a labelled, editable
 * placeholder, never a made-up specification.
 */
export interface StructureInput {
  text: string;
  classification: Classification;
  requirements: Requirement[];
  /** Assumptions the user reviewed (replaces generated placeholders). */
  assumptions?: string[] | null;
  /** Answers to clarification questions, keyed by missing-information key. */
  answers?: Record<string, string> | null;
}

const FILLER_STEPS = STEPS.filter((s) => s.key === "filler" || s.key === "verbose");
/** Remove list markers and politeness filler; capitalise. Never rewrites meaning. */
const strip = (s: string) => {
  const bare = s.replace(/^([-*•]|\d+[.)])\s+/, "").trim();
  const tidy = FILLER_STEPS.reduce((t, step) => step.apply(t), bare).trim();
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
};

const DEFAULT_ASSUMPTION = /: not specified\. If it matters, ask before choosing/;

/** Placeholder assumptions for missing information: labelled, editable and non-committal. */
export function defaultAssumptions(c: Classification): string[] {
  return c.missing_information.map((m) => `${m.label}: not specified. If it matters, ask before choosing; otherwise state the choice you make.`);
}

export function buildIntent(input: StructureInput): IntentRepresentation {
  const { text, classification: c, requirements } = input;
  const reqIds = new Set(requirements.map((r) => `${r.start}`));
  const reqTexts = new Set(requirements.map((r) => normaliseSentence(r.text)));
  const context: string[] = clauses(text)
    .filter((cl) => !cl.code && !reqIds.has(`${cl.start}`) && !reqTexts.has(normaliseSentence(cl.text)))
    .map((cl) => strip(cl.text));
  const answers = Object.entries(input.answers ?? {}).filter(([, v]) => v?.trim());
  for (const [key, value] of answers) {
    const label = c.missing_information.find((m) => m.key === key)?.label ?? key.replace(/_/g, " ");
    context.push(`${label}: ${value.trim()}`);
  }
  const answered = new Set(answers.map(([k]) => k));
  const by = (kinds: Requirement["kind"][]) => requirements.filter((r) => kinds.includes(r.kind)).map((r) => (r.kind === "example" ? r.text : strip(r.text)));
  const objective = requirements.find((r) => r.kind === "objective");
  const ir = {
    task_type: c.primary,
    objective: clip(objective ? strip(objective.text) : c.objective || text, 400),
    context: context.slice(0, 20).map((s) => clip(s, 600)),
    requirements: by(["functional", "technical", "value", "dependency", "example"]).slice(0, 40).map((s) => s.slice(0, 600)),
    constraints: by(["restriction", "tone"]).slice(0, 30).map((s) => clip(s, 600)),
    output_format: by(["format", "length"]).slice(0, 10).map((s) => clip(s, 400)),
    missing_information: c.missing_information.filter((m) => !answered.has(m.key)).map((m) => m.key).slice(0, 12),
    assumptions: (input.assumptions ?? defaultAssumptions({ ...c, missing_information: c.missing_information.filter((m) => !answered.has(m.key)) }))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((s) => clip(s, 400)),
    must_preserve: requirements.filter((r) => r.essential).map((r) => r.text.slice(0, 600)).slice(0, 40),
  };
  return intentRepresentationSchema.parse(ir);
}

export interface RenderOptions {
  mode: GenerationMode;
  /** Kinds of suggestions the user accepted; rendered as labelled placeholders, never as advice text. */
  acceptedKinds?: SuggestionKind[];
  acceptedChanges?: string[];
  customObjective?: string | null;
  questions?: Array<{ key: string; question: string }>;
}

function sectionContent(section: TemplateSection, ir: IntentRepresentation, opts: RenderOptions, used: Set<string>): string[] {
  const take = (items: string[]) => items.filter((i) => !used.has(i)).map((i) => (used.add(i), i));
  switch (section.source) {
    case "objective":
      return take([ir.objective]);
    case "context":
      return take(ir.context);
    case "requirements":
      return take(ir.requirements);
    case "constraints":
      return take(ir.constraints);
    case "output_format":
      return take(ir.output_format);
    case "assumptions":
      return take(ir.assumptions);
    case "open_questions":
      return take((opts.questions ?? []).filter((q) => ir.missing_information.includes(q.key)).map((q) => q.question));
    default:
      return [];
  }
}

const bullets = (items: string[]) => items.map((i) => (i.startsWith("```") ? i : `- ${i.replace(/\s+$/, "")}`)).join("\n");

/** Deterministic renderer: used by the local provider and as a safe fallback. */
export function renderPrompt(ir: IntentRepresentation, template: PromptTemplate, opts: RenderOptions): string {
  if (opts.mode === "token_saver") {
    return compress([ir.objective, ...ir.context, ...ir.requirements, ...ir.constraints, ...ir.output_format].join("\n")).text;
  }
  const detailed = opts.mode === "detailed" || opts.mode === "quality_first";
  const used = new Set<string>();
  const blocks: string[] = [];
  const kinds = new Set(opts.acceptedKinds ?? []);
  const h = (heading: string) => (detailed ? `## ${heading}` : `${heading}:`);
  // Accepted suggestions become explicit, labelled gaps for the user to fill.
  const extras: string[] = [];
  if (kinds.has("output_format") && !ir.output_format.length) extras.push(`${h("Output format")}\n[Add: format and length, for example 5 bullet points, a table, or under 200 words]`);
  if (kinds.has("specificity")) extras.push(`${h("Must cover")}\n[Add: the specific points, features or questions the answer must include]`);
  if (kinds.has("examples")) extras.push(`${h("Example of the output you want")}\n[Paste a short example here]`);
  if (kinds.has("contradictions")) extras.push(`${h("Priority")}\n[Resolve: say which of the conflicting instructions should win]`);
  if ((kinds.has("missing_context") || kinds.has("constraints")) && !ir.context.length) extras.push(`${h("Context")}\n[Add: who this is for, the situation, and anything to avoid]`);
  if (detailed && template.role) blocks.push(template.role);
  for (const section of template.sections) {
    if (section.detailedOnly && !detailed) continue;
    if (section.source === "assumptions" && extras.length) blocks.push(...extras.splice(0));
    // Lighter modes keep only assumptions the user wrote; gaps become one "ask first" line.
    if (!detailed && section.source === "open_questions") continue;
    if (!detailed && section.source === "assumptions" && !ir.assumptions.some((a) => !DEFAULT_ASSUMPTION.test(a))) continue;
    const items = sectionContent(section, ir, opts, used);
    if (section.source === "objective") {
      if (items[0]) blocks.push(detailed ? `## ${section.heading}\n${items[0]}` : items[0]);
      continue;
    }
    if (items.length) {
      blocks.push(`${detailed ? "## " : ""}${section.heading}${detailed ? "" : ":"}\n${bullets(items)}`);
    } else if (detailed && section.missingKey && ir.missing_information.includes(section.missingKey)) {
      blocks.push(`## ${section.heading}\n[Add: ${section.guidance.replace(/\.$/, "")}]`);
    }
  }
  blocks.push(...extras);
  if (!detailed && ir.missing_information.length) {
    blocks.push(`If any of these matter and are unclear, ask first: ${ir.missing_information.map((k) => k.replace(/_/g, " ")).join(", ")}.`);
  }
  if (opts.mode === "quality_first") {
    if (!ir.output_format.length) blocks.push("## Output format\nState the structure you will use before answering, and keep to it.");
    blocks.push("Before answering, check each requirement above is met. If a requirement is ambiguous, say how you interpreted it.");
  }
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderForCategory(input: StructureInput, opts: RenderOptions): { ir: IntentRepresentation; text: string; template: PromptTemplate } {
  const ir = buildIntent(input);
  const template = templateFor(ir.task_type);
  return { ir, template, text: renderPrompt(ir, template, opts) };
}
