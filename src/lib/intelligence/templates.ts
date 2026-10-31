import type { IntentCategory } from "./categories";

/**
 * Category-specific prompt templates (§5). A template is an ordered list of
 * sections; `source` says which part of the structured intent fills it. Add a
 * category by adding an entry here — nothing else needs to change.
 */
export type SectionSource =
  | "role"
  | "objective"
  | "context"
  | "requirements"
  | "constraints"
  | "output_format"
  | "assumptions"
  | "open_questions"
  | "guidance";

export interface TemplateSection {
  key: string;
  heading: string;
  source: SectionSource;
  /** Shown to the model and, when the section is empty, as a placeholder hint. */
  guidance: string;
  /** Only rendered in detailed / quality-first output. */
  detailedOnly?: boolean;
  /** Information that, when absent, materially affects the result (drives missing-info detection). */
  missingKey?: string;
}

export interface PromptTemplate {
  id: string;
  version: number;
  label: string;
  categories: IntentCategory[];
  role: string | null;
  sections: TemplateSection[];
}

const objective: TemplateSection = { key: "objective", heading: "Objective", source: "objective", guidance: "What should be produced and why." };
const context: TemplateSection = { key: "context", heading: "Context", source: "context", guidance: "Background the assistant needs." };
const constraints: TemplateSection = { key: "constraints", heading: "Constraints", source: "constraints", guidance: "Limits, exclusions and must-nots." };
const output: TemplateSection = { key: "output", heading: "Output format", source: "output_format", guidance: "Structure, length and format of the answer." };
const assumptions: TemplateSection = { key: "assumptions", heading: "Assumptions (edit or remove)", source: "assumptions", guidance: "Labelled assumptions the user can change." };
const questions: TemplateSection = { key: "questions", heading: "Open questions", source: "open_questions", guidance: "Ask before answering if these matter." };

export const TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "coding",
    version: 1,
    label: "Software development",
    categories: ["software_development"],
    role: "You are a senior software engineer.",
    sections: [
      objective,
      context,
      { key: "stack", heading: "Technology stack", source: "guidance", guidance: "Languages, frameworks, versions and services to use.", missingKey: "technology_stack" },
      { key: "functional", heading: "Functional requirements", source: "requirements", guidance: "What the software must do." },
      { key: "nonfunctional", heading: "Non-functional requirements", source: "guidance", guidance: "Performance, security, accessibility and reliability expectations.", detailedOnly: true },
      constraints,
      { key: "deliverables", heading: "Deliverables", source: "output_format", guidance: "Code, files, explanations or diffs expected." },
      { key: "testing", heading: "Testing and acceptance criteria", source: "guidance", guidance: "How the result will be checked.", detailedOnly: true, missingKey: "acceptance_criteria" },
      assumptions,
      questions,
    ],
  },
  {
    id: "writing",
    version: 1,
    label: "Writing",
    categories: ["writing_communication", "creative_ideation"],
    role: null,
    sections: [
      objective,
      { key: "audience", heading: "Audience", source: "guidance", guidance: "Who will read it and what they already know.", missingKey: "audience" },
      context,
      { key: "tone", heading: "Tone and style", source: "guidance", guidance: "Voice, register and style.", missingKey: "tone" },
      { key: "points", heading: "Key points", source: "requirements", guidance: "Points that must be covered." },
      constraints,
      { key: "length", heading: "Length and format", source: "output_format", guidance: "Word count, structure and format.", missingKey: "length" },
      { key: "outcome", heading: "Intended outcome", source: "guidance", guidance: "What the reader should think or do afterwards.", detailedOnly: true },
      assumptions,
      questions,
    ],
  },
  {
    id: "research",
    version: 1,
    label: "Research",
    categories: ["research_analysis", "education_tutoring"],
    role: null,
    sections: [
      { ...objective, heading: "Research question" },
      { key: "scope", heading: "Scope", source: "context", guidance: "What is in and out of scope.", missingKey: "scope" },
      { key: "dates", heading: "Date range", source: "guidance", guidance: "Time period, where relevant.", detailedOnly: true, missingKey: "date_range" },
      { key: "evidence", heading: "Evidence and sources", source: "requirements", guidance: "Evidence standards and acceptable sources.", missingKey: "source_requirements" },
      { key: "framework", heading: "Analytical framework", source: "guidance", guidance: "How to compare, weigh or structure findings.", detailedOnly: true },
      constraints,
      { key: "structure", heading: "Output structure", source: "output_format", guidance: "Sections, citations and length." },
      assumptions,
      questions,
    ],
  },
  {
    id: "business",
    version: 1,
    label: "Business strategy",
    categories: ["business_strategy", "marketing_seo"],
    role: null,
    sections: [
      { ...objective, heading: "Business objective" },
      { key: "situation", heading: "Current situation", source: "context", guidance: "Market, company and constraints today.", missingKey: "current_situation" },
      { key: "audience", heading: "Audience", source: "guidance", guidance: "Customers or stakeholders involved.", missingKey: "target_audience" },
      { key: "requirements", heading: "Requirements", source: "requirements", guidance: "What the recommendation must address." },
      constraints,
      { key: "criteria", heading: "Options and evaluation criteria", source: "guidance", guidance: "How options should be compared.", detailedOnly: true },
      { key: "risks", heading: "Risks", source: "guidance", guidance: "Risks to identify and mitigate.", detailedOnly: true },
      { key: "metrics", heading: "Recommendations and success metrics", source: "output_format", guidance: "What to deliver and how success is measured.", missingKey: "success_metrics" },
      assumptions,
      questions,
    ],
  },
  {
    id: "data",
    version: 1,
    label: "Data analysis",
    categories: ["data_analysis"],
    role: null,
    sections: [
      { key: "dataset", heading: "Dataset context", source: "context", guidance: "What the data is, where it comes from, size.", missingKey: "dataset_description" },
      { ...objective, heading: "Business question" },
      { key: "fields", heading: "Field definitions", source: "guidance", guidance: "Meaning and type of the key fields.", detailedOnly: true, missingKey: "field_definitions" },
      { key: "quality", heading: "Data-quality checks", source: "guidance", guidance: "Missing values, outliers, duplicates.", detailedOnly: true },
      { key: "methods", heading: "Analytical methods", source: "requirements", guidance: "Methods or statistics to use." },
      constraints,
      { key: "output", heading: "Output requirements", source: "output_format", guidance: "Tables, charts, summary." },
      { key: "limits", heading: "Limitations", source: "guidance", guidance: "Caveats to state.", detailedOnly: true },
      assumptions,
      questions,
    ],
  },
  {
    id: "planning",
    version: 1,
    label: "Project planning",
    categories: ["project_planning"],
    role: null,
    sections: [
      objective,
      context,
      { key: "scope", heading: "Scope and deliverables", source: "requirements", guidance: "What the plan must cover." },
      { key: "timeline", heading: "Timeline and resources", source: "guidance", guidance: "Deadlines, team size and budget.", missingKey: "timeline" },
      constraints,
      { key: "risks", heading: "Risks and dependencies", source: "guidance", guidance: "What could block progress.", detailedOnly: true },
      output,
      assumptions,
      questions,
    ],
  },
  {
    id: "general",
    version: 1,
    label: "General",
    categories: ["general", "unknown"],
    role: null,
    sections: [objective, context, { key: "requirements", heading: "Requirements", source: "requirements", guidance: "What the answer must include." }, constraints, output, assumptions, questions],
  },
];

export function templateFor(category: IntentCategory): PromptTemplate {
  return TEMPLATES.find((t) => t.categories.includes(category)) ?? (TEMPLATES.find((t) => t.id === "general") as PromptTemplate);
}

export function templateById(id: string): PromptTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
