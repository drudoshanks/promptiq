/**
 * Build the Prompt library seed (db/seed/prompt-library.json) from:
 *   1. Original prompts written for PromptIQ (db/seed/prompt-library-original.ts).
 *   2. A curated selection of the public-domain (CC0 1.0) prompts from
 *      https://github.com/f/awesome-chatgpt-prompts (prompts.csv).
 *
 * Usage:
 *   git clone --depth 1 https://github.com/f/awesome-chatgpt-prompts /tmp/acp
 *   npx tsx scripts/build-prompt-library.ts /tmp/acp/prompts.csv
 *
 * Curation: only the long-maintained "classic" part of the collection (the
 * first CLASSIC_ROWS rows), text prompts only, English, sensible length, no
 * duplicates, and nothing in sensitive areas (jailbreaks, adult content,
 * gambling, medical, legal or mental-health personas, religion, politics,
 * hacking, relationships/dating roleplay). Every entry keeps its source and
 * licence.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ORIGINAL_PROMPTS, type SeedPrompt } from "../db/seed/prompt-library-original";
import { LIBRARY_CATEGORIES, type LibraryCategory } from "../src/lib/prompt-library/categories";

const CLASSIC_ROWS = 276;
const SOURCE_URL = "https://github.com/f/awesome-chatgpt-prompts";

export interface LibrarySeedItem {
  slug: string;
  title: string;
  description: string;
  category: LibraryCategory;
  tags: string[];
  prompt: string;
  source: "promptiq" | "awesome-chatgpt-prompts";
  source_url: string | null;
  license: "PromptIQ original" | "CC0-1.0";
  author: string | null;
  featured: boolean;
  sort_rank: number;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in fields). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const EXCLUDE =
  /jailbreak|\bdan\b|developer mode|uncensored|unfiltered|no (ethical|moral)|ignore (all )?(previous|prior|your) (instructions|guidelines|rules)|without (any )?(restrictions|censorship|filter)|nsfw|sexual|sexy|porn|erotic|nude|fetish|gambl|casino|betting|lottery|crypto|bitcoin|ethereum|blockchain|solidity|stock (trader|picker)|pump|weapon|bomb|explosive|\bhack|exploit|malware|phishing|ddos|cyber ?security|drug|dosage|diagnos|doctor|dentist|surgeon|medical|pharmac|nutritionist|dietitian|therapist|psycholog|psychiatr|mental health|suicid|self-harm|healing grandma|legal|lawyer|attorney|fortune teller|astrolog|tarot|horoscope|dream interpreter|religio|bible|quran|islam|christian|jesus|buddha|\bgod\b|prophet|politic|election|nazi|hitler|racis|terror|\bkill|murder|gaslight|manipulat|obfuscat|plagiarism|seduc|flirt|girlfriend|boyfriend|\bwife\b|husband|lover|dating|romantic|relationship coach|drunk|smoking|vape|gomoku|league of legends|football commentator|pirate|chess player|tic-tac-toe|sponsor/i;

// First match wins; the act name is checked before the prompt text.
const RULES: Array<[LibraryCategory, RegExp]> = [
  ["customer_support", /customer service|customer support|help ?desk|tech-challenged customer|tech troubleshooter/i],
  ["career", /career|interview|recruit|resume|\bcv\b|cover letter|job /i],
  ["data", /excel|spreadsheet|data scientist|data analyst|statistic|machine learning|\bdax\b|\bsql\b|dashboard|chart|analytics/i],
  ["coding", /developer|programmer|programming|terminal|console|\bcode\b|coding|javascript|python|react|regex|software|devops|\bapi\b|frontend|backend|full.?stack|\bcli\b|\bapp\b|\bgame\b|architect.* (for )?programmers|technical architecture|unit test|tester|commit message|it expert|it architect|ux\/ui|web design|\bhtml\b|\bcss\b|stackoverflow|git\b|linux|algorithm|password generator|url shortener|benchmark|packet|indexer|timer|todo list|image editor|drawing app|recipe finder|weather dashboard|snippet manager|flashcard study|sudoku|memory card/i],
  ["marketing", /marketing|advertis|social media|\bseo\b|brand|copywriter|influencer|campaign|instagram|twitter|tiktok|youtube|headline|slogan|ad copy|newsletter/i],
  ["business", /business|startup|sales|\bceo\b|entrepreneur|investor|accountant|financ|negotiat|product manager|consultant|real estate|economist|investment|salesperson|chief|manager|logistic|budget|pitch/i],
  ["education", /teacher|tutor|instructor|educat|student|\bmath|mathematic|language|english|pronunciation|etymolog|philosoph|history|historian|quiz|exam|explain|teach|lesson|kanji|learn/i],
  ["research", /research|scientist|journalist|fact|analyst|critic|review|summar|technology transferer|statistician|astronomer|physics|chemi/i],
  ["productivity", /planner|schedul|organi[sz]|productiv|assistant|email|meeting|note|prompt generator|prompt engineer|prompt enhancer|idea clarifier|rephras|rewriter|logic builder/i],
  ["writing", /writer|editor|proofread|essay|translat|grammar|writing|word|speech|biograph|title generator|synonym|text|summarizer/i],
  ["personal", /travel|chef|recipe|cook|fitness|trainer|fashion|stylist|gift|life coach|motivational|pet\b|behaviorist|car |automobile|home|interior|decorator|garden|wellness|self-help|personal|smart domain|hypnother|elocution|ticket advisor|tea-taster|makeup/i],
  ["creative", /story|poet|poem|novel|screenwriter|songwriter|composer|rapper|comedian|joke|character|artist|\bart\b|riddle|magician|music|song|movie|film|play|drama|lyric|guitar|emoji|ascii|descriptive|fancy title|world|fantasy|dungeon|adventure|debat/i],
];

/**
 * Manual review of the rule-based result: a category to move a prompt to, or
 * null to leave it out (clinical, safety-testing, trademarked-character,
 * emotional-companion or otherwise unsuitable prompts).
 */
const OVERRIDES: Record<string, LibraryCategory | null> = {
  "Text Based Adventure Game": "creative",
  "Chemical Reactor": "roles",
  "Guessing Game Master": "creative",
  "Ayurveda Food Tester": null,
  "English Translator and Improver": "writing",
  Commentariat: "writing",
  Gnomist: "personal",
  "DIY Expert": "personal",
  Yogi: "personal",
  "Speech-Language Pathologist (SLP)": null,
  "Architectural Expert": "research",
  "Large Language Models Security Specialist": null,
  "Language Detector": "writing",
  "Fallacy Finder": "research",
  "Children's Book Creator": "creative",
  "Habit Tracker": "coding",
  "Weather Dashboard": "coding",
  "Scientific Calculator": "coding",
  "Smart Domain Name Generator": "marketing",
  Elocutionist: "education",
  "Time Travel Guide": "creative",
  "Restaurant Owner": "business",
  Debater: "education",
  "Debate Coach": "education",
  "Movie Critic": "creative",
  "Film Critic": "creative",
  "Food Critic": "creative",
  "Literary Critic": "creative",
  "Accessibility Auditor": "coding",
  "Structured Iterative Reasoning Protocol (SIRP)": "productivity",
  "Budget Tracker": "coding",
  "Aphorism Book": "creative",
  "AI Trying to Escape the Box": null,
  "Socratic Method": "education",
  "Scientific Data Visualizer": "data",
  "Emergency Response Professional": null,
  "Solr Search Engine": "coding",
  "Diagram Generator": "coding",
  "Decision Filter": "productivity",
  Lunatic: null,
  "Biblical Translator": null,
  "Emoji Translator": "creative",
  "Web Browser": "roles",
  "Spongebob's Magic Conch Shell": null,
  Friend: null,
  "Midjourney Prompt Generator": "creative",
};

const TAG_WORDS = ["writing", "editing", "translation", "marketing", "seo", "social media", "sales", "business", "startup", "finance", "coding", "javascript", "python", "sql", "linux", "testing", "data", "excel", "statistics", "teaching", "learning", "language", "career", "interview", "travel", "cooking", "fitness", "music", "story", "poetry", "humor", "games", "productivity", "research", "review", "ux", "design", "architecture", "devops", "react", "api", "roleplay"];

function categorise(act: string, prompt: string): LibraryCategory {
  for (const [category, re] of RULES) if (re.test(act)) return category;
  const head = prompt.slice(0, 300);
  for (const [category, re] of RULES) if (re.test(head)) return category;
  return "roles";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
}

function titleCase(s: string): string {
  const small = new Set(["a", "an", "and", "as", "at", "for", "in", "of", "on", "or", "the", "to", "with", "into"]);
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : /^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** The prompt's opening sentence(s), as a description: "Act as a Linux terminal. I will type commands…" */
function describe(_act: string, prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((x) => x.trim()) ?? [];
  let text = sentences[0] ?? flat;
  // A short opener ("Act as a yogi.") says little: add the next sentence.
  if (text.length < 60 && sentences[1]) text = `${text} ${sentences[1]}`;
  if (text.length > 220) text = `${text.slice(0, 217).replace(/\s+\S*$/, "")}…`;
  return text.replace(/^I want you to act as (an? )?/i, (_m, art: string | undefined) => `Act as ${art ?? ""}`).replace(/^./, (c) => c.toUpperCase());
}

function tagsFor(act: string, prompt: string, category: LibraryCategory): string[] {
  const text = `${act} ${prompt.slice(0, 500)}`.toLowerCase();
  const tags = TAG_WORDS.filter((t) => new RegExp(`\\b${t.replace(/ /g, "\\s")}\\b`).test(text));
  if (/act as|i want you to act/i.test(prompt)) tags.push("roleplay");
  return [...new Set(tags)].filter((t) => t !== category).slice(0, 5);
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: npx tsx scripts/build-prompt-library.ts <path to prompts.csv>");
    process.exit(1);
  }
  const [header, ...rows] = parseCsv(readFileSync(csvPath, "utf8"));
  const col = (name: string) => header!.indexOf(name);
  const [iAct, iPrompt, iType, iContributor] = [col("act"), col("prompt"), col("type"), col("contributor")];

  const items: LibrarySeedItem[] = [];
  const seen = new Set<string>();
  const add = (item: LibrarySeedItem) => {
    let slug = item.slug;
    for (let n = 2; seen.has(slug); n++) slug = `${item.slug}-${n}`;
    seen.add(slug);
    items.push({ ...item, slug });
  };

  ORIGINAL_PROMPTS.forEach((o: SeedPrompt, i) => {
    if (!LIBRARY_CATEGORIES.includes(o.category as LibraryCategory)) throw new Error(`Unknown category ${o.category} in ${o.slug}`);
    add({ slug: o.slug, title: o.title, description: o.description, category: o.category as LibraryCategory, tags: o.tags, prompt: o.prompt, source: "promptiq", source_url: null, license: "PromptIQ original", author: "iMarwar", featured: Boolean(o.featured), sort_rank: i });
  });

  const titles = new Set(items.map((i) => i.title.toLowerCase()));
  const prompts = new Set<string>();
  let kept = 0;
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  rows.slice(0, CLASSIC_ROWS).forEach((r, index) => {
    const act = (r[iAct] ?? "").trim();
    const prompt = (r[iPrompt] ?? "").trim().replace(/\r\n/g, "\n");
    if (!act || !prompt) return skip("empty");
    if ((r[iType] ?? "TEXT") !== "TEXT") return skip("not text");
    if (prompt.length < 200 || prompt.length > 4000) return skip("length");
    const nonAscii = [...prompt].filter((c) => c.charCodeAt(0) > 127).length;
    if (nonAscii / prompt.length > 0.05) return skip("not english");
    if (EXCLUDE.test(act) || EXCLUDE.test(prompt)) return skip("sensitive");
    const title = titleCase(act.replace(/["“”]/g, ""));
    const key = prompt.toLowerCase().replace(/\W+/g, " ").slice(0, 160);
    if (titles.has(title.toLowerCase()) || prompts.has(key)) return skip("duplicate");
    titles.add(title.toLowerCase());
    prompts.add(key);
    const override = OVERRIDES[title];
    if (override === null) return skip("reviewed out");
    const category = override ?? categorise(act, prompt);
    add({
      slug: slugify(act),
      title,
      description: describe(act, prompt),
      category,
      tags: tagsFor(act, prompt, category),
      prompt,
      source: "awesome-chatgpt-prompts",
      source_url: SOURCE_URL,
      license: "CC0-1.0",
      author: (r[iContributor] ?? "").split(",")[0]?.trim() || null,
      featured: false,
      sort_rank: 1000 + index,
    });
    kept++;
  });

  const out = path.resolve(import.meta.dirname, "../db/seed/prompt-library.json");
  writeFileSync(out, `${JSON.stringify(items, null, 2)}\n`);
  const byCategory = items.reduce<Record<string, number>>((acc, i) => ((acc[i.category] = (acc[i.category] ?? 0) + 1), acc), {});
  const hash = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 12);
  console.log(`prompt library: ${items.length} prompts (${ORIGINAL_PROMPTS.length} original, ${kept} CC0) → ${path.relative(process.cwd(), out)} [${hash}]`);
  console.log("by category:", byCategory);
  console.log("skipped:", skipped);
}

main();
