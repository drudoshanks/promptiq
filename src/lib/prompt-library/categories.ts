/** Prompt library categories, in display order. */
export const LIBRARY_CATEGORIES = [
  "writing",
  "marketing",
  "business",
  "coding",
  "data",
  "education",
  "research",
  "productivity",
  "career",
  "customer_support",
  "personal",
  "creative",
  "roles",
] as const;
export const LIBRARY_SORTS = ["relevant", "popular", "az"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = { relevant: "Best match", popular: "Most used", az: "A to Z" };

export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export const LIBRARY_CATEGORY_LABELS: Record<LibraryCategory, string> = {
  writing: "Writing and editing",
  marketing: "Marketing and social",
  business: "Business and sales",
  coding: "Coding",
  data: "Data and analysis",
  education: "Learning and teaching",
  research: "Research",
  productivity: "Productivity",
  career: "Career",
  customer_support: "Customer support",
  personal: "Everyday life",
  creative: "Creative",
  roles: "Roles and personas",
};

export function isLibraryCategory(value: unknown): value is LibraryCategory {
  return typeof value === "string" && (LIBRARY_CATEGORIES as readonly string[]).includes(value);
}

/** {{field}} placeholders in a prompt, in order of first appearance. */
export function promptVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z][\w ]{0,40}?)\s*\}\}/g)].map((m) => m[1]!.trim()))];
}

/** "word_count" → "Word count". */
export function variableLabel(name: string): string {
  const s = name.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Replace {{field}} placeholders with values; unfilled ones stay as they are. */
export function fillPrompt(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z][\w ]{0,40}?)\s*\}\}/g, (all, name: string) => {
    const v = values[name.trim()];
    return v && v.trim() ? v : all;
  });
}
