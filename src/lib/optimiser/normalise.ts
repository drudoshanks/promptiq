/**
 * Input normalisation (SRS §7.1 step 2): normalise line endings and strip
 * accidental surrounding whitespace only. Internal spacing, indentation and
 * blank lines are semantic (code, lists) and are preserved.
 */
export function normalisePrompt(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .trim();
}
