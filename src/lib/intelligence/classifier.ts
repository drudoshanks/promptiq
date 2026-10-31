import { INTELLIGENCE_CONFIG } from "@/lib/config/intelligence";

import { INTENT_LABELS, type IntentCategory } from "./categories";
import { templateFor } from "./templates";
import { clauses, clip, techTerms, wordCount } from "./text";

/**
 * IntentClassifier (§3). Deterministic weighted keyword rules decide obvious
 * cases; anything below the confidence threshold is marked ambiguous so the
 * caller can ask the model. Never forces a category: weak evidence returns
 * "general" (or "unknown" for prompts too short to tell).
 */
type Rule = [RegExp, number];

const RULES: Record<Exclude<IntentCategory, "general" | "unknown">, Rule[]> = {
  software_development: [
    [/\b(code|coding|function|class|method|bug|debug|stack trace|exception|compile|refactor|repository|repo|pull request|unit tests?|endpoint|api|sdk|cli|backend|frontend|full[- ]stack|database schema|migration|deploy(?:ment)?|devops|algorithm|regex)\b/gi, 2],
    [/\b(app|website|web app|mobile app|ecommerce|e-commerce|saas|dashboard|login|authentication|component)\b/gi, 1],
  ],
  writing_communication: [
    [/\b(email|e-mail|letter|cover letter|memo|newsletter|press release|announcement|speech|toast|reply|message|linkedin post|essay|article|blog post|proofread|rewrite|edit my|paragraph)\b/gi, 2],
    [/\b(write|draft|tone|wording|polish)\b/gi, 1],
  ],
  research_analysis: [
    [/\b(research|literature|studies|evidence|peer[- ]reviewed|citations?|cite|sources|systematic review|meta-analysis|investigate|compare .{0,30} (?:studies|approaches)|state of the art)\b/gi, 2],
    [/\b(analy[sz]e|analysis|compare|pros and cons|explain why|findings)\b/gi, 1],
  ],
  business_strategy: [
    [/\b(business plan|strategy|strategic|go[- ]to[- ]market|gtm|pricing strategy|competitor|competitive|market entry|swot|business model|profitability|stakeholders|okrs?|investors?|pitch|unit economics|expansion)\b/gi, 2],
    [/\b(startup|company|growth|market|customers|board|revenue)\b/gi, 1],
  ],
  marketing_seo: [
    [/\b(seo|keywords?|meta description|search ranking|backlinks?|marketing|campaign|ad copy|ads|landing page copy|conversion|ctr|social media|instagram|tiktok|brand voice|tagline|slogan|newsletter subject|email campaign|funnel)\b/gi, 2],
    [/\b(audience|engagement|promote|launch)\b/gi, 1],
  ],
  data_analysis: [
    [/\.(?:csv|xlsx?|parquet|json)\b|\b(top \d+ \w+ by|group by|aggregate|markdown table|dataset|data set|csv|spreadsheet|excel|sql query|pivot|regression|correlation|statistic(?:s|al)|mean|median|outliers?|visuali[sz]e|chart|dashboard metrics|pandas|columns?|rows?|time series|forecast|cohort)\b/gi, 2],
    [/\b(data|metrics|kpis?|trend)\b/gi, 1],
  ],
  education_tutoring: [
    [/\b(teach me|explain .{0,20} (?:to a|like i'?m)|tutor|lesson plan|curriculum|quiz|flashcards?|homework|exam|students?|learning objectives|study guide|eli5|beginner)\b/gi, 2],
    [/\b(learn|understand|explain|course|class)\b/gi, 1],
  ],
  creative_ideation: [
    [/\b(story|short story|poem|poetry|lyrics|novel|screenplay|script|characters?|plot|fantasy|fiction|brainstorm|ideas for|names for|creative|worldbuilding|haiku)\b/gi, 2],
    [/\b(imagine|invent|fun|whimsical)\b/gi, 1],
  ],
  project_planning: [
    [/\b(project plan|roadmap|milestones?|timeline|gantt|sprint|backlog|deliverables|work breakdown|resource plan|schedule|deadline|kickoff|raci|dependencies|project management)\b/gi, 2],
    [/\b(plan|phases?|tasks?|team)\b/gi, 1],
  ],
};

export interface Classification {
  primary: IntentCategory;
  secondary: IntentCategory | null;
  objective: string;
  confidence: number;
  template_id: string;
  missing_information: MissingInfo[];
  method: "rules" | "model" | "user";
  ambiguous: boolean;
  scores: Partial<Record<IntentCategory, number>>;
}

export interface MissingInfo {
  key: string;
  label: string;
  question: string;
}

function scoreRules(text: string): Array<[IntentCategory, number]> {
  const out: Array<[IntentCategory, number]> = [];
  for (const [cat, rules] of Object.entries(RULES) as Array<[IntentCategory, Rule[]]>) {
    let score = 0;
    for (const [re, weight] of rules) score += (text.match(re)?.length ?? 0) * weight;
    if (techTerms(text).length && cat === "software_development") score += 2 * Math.min(2, techTerms(text).length);
    if (score > 0) out.push([cat, score]);
  }
  // On a tie the more specific category wins: "write" alone says little about the task.
  return out.sort((a, b) => b[1] - a[1] || (a[0] === "writing_communication" ? 1 : b[0] === "writing_communication" ? -1 : 0));
}

/** The user's objective: the first instruction-like clause, trimmed. */
export function extractObjective(text: string): string {
  const parts = clauses(text).filter((c) => !c.code);
  const first = parts.find((c) => /\b(write|create|build|make|need|want|help|explain|list|summari[sz]e|compare|generate|design|draft|plan|analy[sz]e|give|find|develop|implement|research|teach|review|prepare|propose)\b/i.test(c.text)) ?? parts[0];
  if (!first) return "";
  const objective = clip(first.text.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/^(please|kindly|hey|hi)[,!]?\s+/i, "").replace(/^(can|could|would) you\s+(please\s+)?/i, ""), 200).replace(/\?$/, ".");
  return objective.charAt(0).toUpperCase() + objective.slice(1);
}

const MISSING_DETECTORS: Record<string, { label: string; question: string; present: RegExp }> = {
  technology_stack: { label: "Technology stack", question: "Which languages, frameworks or services should it use?", present: /(?!)/ },
  acceptance_criteria: { label: "Acceptance criteria", question: "How will you check the result is correct (tests, criteria)?", present: /\b(tests?|acceptance|criteria|done when|should pass|verify)\b/i },
  payment_provider: { label: "Payment provider", question: "Which payment provider should checkout use (for example Stripe or PayPal)?", present: /\b(stripe|paypal|razorpay|adyen|square|braintree|payment provider|no payments?)\b/i },
  target_users: { label: "Target users", question: "Who are the users, and what do they need to do?", present: /\b(users? (?:are|who|can)|customers|audience|for (?:small|our|my|busy|non-technical|developers|students|teams|businesses))\b/i },
  audience: { label: "Audience", question: "Who will read this, and what do they already know?", present: /\b(audience|readers?|for (?:my|our|a|an|the\s)?(?:[\w-]+\s){0,2}[\w-]+(?:s|ers|ees|ents|ists)\b|to (?:my|our|the) \w+|customers|clients|colleagues|manager|team|investors|recruiters?|students|beginners|experts)\b/i },
  tone: { label: "Tone", question: "What tone should it have (for example formal, friendly, persuasive)?", present: /\b(tone|voice|formal|informal|casual|friendly|professional|playful|witty|neutral|persuasive|warm|humorous|serious)\b/i },
  length: { label: "Length", question: "How long should it be?", present: /\b\d+[\s-]*(words?|characters?|sentences?|paragraphs?|pages?|bullets?|points?|lines?|slides?|minutes?)\b|\b(short|brief|concise|one[- ]page|long-form|detailed)\b/i },
  scope: { label: "Scope", question: "What is in scope, and what should be left out?", present: /\b(scope|focus on|limit(?:ed)? to|only|exclude|in particular|specifically)\b/i },
  date_range: { label: "Date range", question: "Which time period should the research cover?", present: /\b(19|20)\d{2}\b|\b(last|past)\s+\d+\s+(years?|months?)\b|\b(recent|latest|current|since)\b/i },
  source_requirements: { label: "Source requirements", question: "What kinds of sources are acceptable, and should they be cited?", present: /\b(sources?|cite|citations?|references?|peer[- ]reviewed|studies|papers|links?)\b/i },
  current_situation: { label: "Current situation", question: "What is the current situation (company, market, numbers)?", present: /\b(we are|we're|our (?:company|team|startup|business|product)|currently|today we|at the moment|we have)\b/i },
  target_audience: { label: "Target audience", question: "Who is the target customer or audience?", present: /\b(audience|customers?|buyers?|users?|segment|persona|b2b|b2c|smbs?|enterprises?)\b/i },
  success_metrics: { label: "Success metrics", question: "How will success be measured?", present: /\b(kpis?|metrics?|measure|success|target of|goal of|increase .{0,20}by|roi)\b/i },
  dataset_description: { label: "Dataset description", question: "What does the dataset contain (source, size, columns)?", present: /\b(dataset|data set|csv|table|spreadsheet|columns?|rows?|fields?|records)\b/i },
  field_definitions: { label: "Field definitions", question: "What do the key columns mean?", present: /\b(columns?|fields?)\s*(?:are|:|include|such as)|\b\w+_\w+\b/i },
  timeline: { label: "Timeline", question: "What are the deadlines, team size and budget?", present: /\b(deadline|weeks?|months?|quarters?|q[1-4]|by (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)|timeline|budget|team of)\b/i },
};

/** Material information missing for this category, from the template plus domain cues. */
export function detectMissingInformation(text: string, category: IntentCategory): MissingInfo[] {
  const keys: string[] = templateFor(category).sections.map((s) => s.missingKey).filter((k): k is string => Boolean(k));
  if (category === "software_development") {
    if (/\b(e-?commerce|shop|store|checkout|payments?|subscriptions?|billing)\b/i.test(text)) keys.push("payment_provider");
    if (/\b(website|web app|app|platform|saas|portal|dashboard)\b/i.test(text)) keys.push("target_users");
  }
  const out: MissingInfo[] = [];
  for (const key of [...new Set(keys)]) {
    const d = MISSING_DETECTORS[key];
    if (!d) continue;
    const present = key === "technology_stack" ? techTerms(text).length > 0 || /\b(stack|framework|language)\b/i.test(text) : d.present.test(text);
    if (!present) out.push({ key, label: d.label, question: d.question });
  }
  return out;
}

export function missingInfoFor(key: string): MissingInfo | null {
  const d = MISSING_DETECTORS[key];
  return d ? { key, label: d.label, question: d.question } : null;
}

/** Rule-based classification. `ambiguous` tells the caller a model check is worthwhile. */
export function classifyByRules(text: string): Classification {
  const scored = scoreRules(text);
  const [top, second] = scored;
  const words = wordCount(text);
  let primary: IntentCategory;
  let confidence: number;
  if (!top) {
    primary = words < 4 ? "unknown" : "general";
    confidence = words < 4 ? 0.2 : 0.45;
  } else {
    const margin = (top[1] - (second?.[1] ?? 0)) / top[1];
    confidence = Math.min(0.95, 0.35 + 0.08 * Math.min(top[1], 5) + 0.25 * margin);
    primary = confidence < 0.4 ? "general" : top[0];
  }
  const secondary = top && second && second[1] >= top[1] * 0.5 && primary !== second[0] ? second[0] : null;
  return {
    primary,
    secondary,
    objective: extractObjective(text),
    confidence: Math.round(confidence * 100) / 100,
    template_id: templateFor(primary).id,
    missing_information: detectMissingInformation(text, primary),
    method: "rules",
    ambiguous: confidence < INTELLIGENCE_CONFIG.ruleConfidenceThreshold,
    scores: Object.fromEntries(scored),
  };
}

/** Apply a user's manual category choice; confidence is then the user's, not ours. */
export function withUserCategory(c: Classification, category: IntentCategory, text: string): Classification {
  if (category === c.primary) return { ...c, method: "user", ambiguous: false };
  return {
    ...c,
    secondary: c.primary === "general" || c.primary === "unknown" ? c.secondary : c.primary,
    primary: category,
    confidence: 1,
    template_id: templateFor(category).id,
    missing_information: detectMissingInformation(text, category),
    method: "user",
    ambiguous: false,
  };
}

export function describeClassification(c: Classification): string {
  const how = c.method === "user" ? "chosen by you" : c.method === "model" ? "classified by the model" : "matched by keyword rules";
  return `${INTENT_LABELS[c.primary]} (${how}, confidence ${Math.round(c.confidence * 100)}%)`;
}

