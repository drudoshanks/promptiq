/**
 * Word-level diff for the comparison view (FR-006). Pure and dependency-free so
 * it runs in the browser. Uses an LCS table over word tokens; inputs beyond
 * DIFF_TOKEN_LIMIT tokens fall back to "no markup" to keep it O(1) for huge
 * prompts rather than O(n·m).
 */
export type DiffSegment = { type: "equal" | "added" | "removed"; text: string };

export const DIFF_TOKEN_LIMIT = 1500;

function tokenise(text: string): string[] {
  // Keep whitespace tokens so the rendered text round-trips exactly.
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenise(before);
  const b = tokenise(after);
  if (a.length > DIFF_TOKEN_LIMIT || b.length > DIFF_TOKEN_LIMIT) {
    return [
      ...(before ? [{ type: "removed", text: before } as DiffSegment] : []),
      ...(after ? [{ type: "added", text: after } as DiffSegment] : []),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (type: DiffSegment["type"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", a[i] as string);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) {
      push("removed", a[i] as string);
      i++;
    } else {
      push("added", b[j] as string);
      j++;
    }
  }
  while (i < a.length) push("removed", a[i++] as string);
  while (j < b.length) push("added", b[j++] as string);
  return segments;
}

/** Segments that belong in the "original" pane (equal + removed). */
export function originalSide(segments: DiffSegment[]): DiffSegment[] {
  return segments.filter((s) => s.type !== "added");
}

/** Segments that belong in the "proposed" pane (equal + added). */
export function proposedSide(segments: DiffSegment[]): DiffSegment[] {
  return segments.filter((s) => s.type !== "removed");
}

export function diffStats(segments: DiffSegment[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const s of segments) {
    const words = s.text.trim() ? s.text.trim().split(/\s+/).length : 0;
    if (s.type === "added") added += words;
    if (s.type === "removed") removed += words;
  }
  return { added, removed };
}
