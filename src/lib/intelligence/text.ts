/** Small, dependency-free text utilities shared by the intelligence modules. */

const STOPWORDS = new Set(
  "a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i me my we our you your he she they them their his her do does did done can could should would will shall may might must not no so than too very just also into about over under up out off only own same such any some each other more most all both few nor once here there when where why how what which who whom whose please kindly want need like make use using get give etc".split(
    " ",
  ),
);

/** Lower-case word tokens (letters, digits, dots/plus/hash inside words like next.js, c++, c#). */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#'-]*[a-z0-9+#]|[a-z0-9]/g) ?? []).map((w) => w.replace(/'s$/, ""));
}

/** Very light stemmer: enough to match "tests"/"testing"/"tested" and "summarise"/"summarize". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/z/g, "s");
  for (const suffix of ["ations", "ation", "ings", "ing", "ies", "ied", "ers", "er", "ed", "es", "ly", "s"]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length) + (suffix === "ies" || suffix === "ied" ? "y" : "");
      break;
    }
  }
  return w.replace(/e$/, "");
}

/** Content words, stemmed, without stopwords. */
export function keyTerms(text: string, max = 8): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w) || w.length < 2) continue;
    const s = stem(w);
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function termSet(text: string): Set<string> {
  return new Set(words(text).filter((w) => !STOPWORDS.has(w)).map(stem));
}

export function normaliseSentence(text: string): string {
  return words(text).join(" ");
}

/** Jaccard similarity of two texts' content terms. */
export function similarity(a: string, b: string): number {
  const x = termSet(a);
  const y = termSet(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

export interface Clause {
  text: string;
  start: number;
  end: number;
  /** True when the clause sits inside a fenced code block or is a code line. */
  code: boolean;
  bullet: boolean;
}

/**
 * Split a prompt into clauses with character offsets: one per bullet or line,
 * and lines into sentences. Fenced code blocks are kept whole.
 */
export function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  const fence = /```[\s\S]*?(```|$)/g;
  let cursor = 0;
  const pushProse = (segment: string, offset: number) => {
    let lineStart = 0;
    for (const line of segment.split("\n")) {
      const lineOffset = offset + lineStart;
      lineStart += line.length + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bullet = /^([-*•]|\d+[.)])\s+/.test(trimmed);
      // Sentence ends only where punctuation is followed by whitespace, so
      // decimals, versions and file names (3.5, next.js) never split.
      const re = /\S[\s\S]*?(?:[.!?;]+(?=\s|$)|$)/g;
      let m: RegExpExecArray | null;
      let lineFirst = true;
      while ((m = re.exec(line))) {
        const t = m[0].trim();
        if (!t) break;
        const s = lineOffset + m.index;
        const prev = out[out.length - 1];
        // Re-join after abbreviations such as "e.g." or "etc.".
        if (!lineFirst && prev && /\b(e\.g|i\.e|etc|vs|approx|incl|[a-z])\.$/i.test(prev.text)) {
          prev.text = line.slice(prev.start - lineOffset, s - lineOffset + t.length).trim();
          prev.end = s + t.length;
        } else {
          out.push({ text: t, start: s, end: s + t.length, code: false, bullet });
        }
        lineFirst = false;
        if (re.lastIndex >= line.length) break;
      }
    }
  };
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    pushProse(text.slice(cursor, m.index), cursor);
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length, code: true, bullet: false });
    cursor = m.index + m[0].length;
  }
  pushProse(text.slice(cursor), cursor);
  return out.filter((c) => c.code || /[a-z0-9]/i.test(c.text));
}

export function sentenceCount(text: string): number {
  return clauses(text).filter((c) => !c.code).length;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Stable short hash for ephemeral IDs (FNV-1a). */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const TECH_TERMS = [
  "react", "next.js", "nextjs", "vue", "angular", "svelte", "node", "node.js", "deno", "django", "flask", "fastapi", "laravel", "python", "typescript", "javascript", "java", "kotlin", "golang", "rust", "c++", "c#", ".net", "php", "ruby", "scala", "sql", "postgres", "postgresql",
  "mysql", "sqlite", "mongodb", "redis", "graphql", "grpc", "docker", "kubernetes", "aws", "gcp", "azure", "vercel", "terraform", "tailwind", "stripe", "paypal",
  "shopify", "firebase", "supabase", "prisma", "drizzle", "pandas", "numpy", "pytorch", "tensorflow", "tableau", "power bi", "bigquery", "snowflake", "html", "css",
  "flutter", "ios", "android", "wordpress", "openai", "jest", "vitest", "playwright", "cypress", "linux", "bash",
];
const TECH_RE = new RegExp(`(?<![\\w.])(${TECH_TERMS.map((t) => t.replace(/[.+#]/g, (c) => `\\${c}`)).join("|")})(?![\\w])`, "gi");

export function techTerms(text: string): string[] {
  return [...new Set((text.match(TECH_RE) ?? []).map((t) => t.toLowerCase()))];
}

/** Values that must survive a rewrite verbatim: numbers with units, quotes, URLs, versions. */
export function exactValues(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.add(m[0].replace(/[.,;)]+$/, ""));
  for (const m of text.matchAll(/"([^"\n]{2,80})"|“([^”\n]{2,80})”|'([^'\n]{3,80})'/g)) out.add((m[1] ?? m[2] ?? m[3] ?? "").trim());
  for (const m of text.matchAll(/\b\d+(?:[.,]\d+)?[\s-]*(%|words?|characters?|chars|sentences?|paragraphs?|pages?|bullets?|points?|items?|lines?|minutes?|hours?|days?|weeks?|months?|years?|ms|seconds?|users?|tokens?|kb|mb|gb|px|usd|\$|€|£)?/gi)) {
    const v = m[0].trim();
    if (/^\d$/.test(v)) continue; // a lone digit is usually a list marker
    out.add(v.toLowerCase().replace(/\s+/g, " "));
  }
  for (const m of text.matchAll(/[$€£]\s?\d[\d,.]*/g)) out.add(m[0].replace(/\s/g, ""));
  return [...out].filter(Boolean);
}

export const NEGATION_RE = /\b(don'?t|do not|never|avoid|without|must not|mustn'?t|should not|shouldn'?t|no|not|exclude|excluding|except|only|cannot|can'?t)\b/i;
