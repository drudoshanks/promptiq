/**
 * Prompt export formats (FR-008, PIQ-010). Pure functions shared by the browser
 * (client-side download) and the server (GET /prompts/{id}/export). JSON exports
 * round-trip exactly; Markdown escapes fenced blocks so the prompt text is
 * recoverable verbatim.
 */
export const EXPORT_FORMATS = ["txt", "md", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportVersion {
  id: string;
  version_number: number;
  provenance: string;
  prompt_text: string;
  change_summary: string[];
  created_at: string;
  token_estimate?: number | null;
  token_estimate_method?: string | null;
}

export interface ExportPrompt {
  id: string;
  title: string;
  category: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface PromptExportDocument {
  format: "promptiq.prompt";
  format_version: 1;
  exported_at: string;
  prompt: ExportPrompt;
  version: ExportVersion;
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

export function exportMimeType(format: ExportFormat): string {
  switch (format) {
    case "txt":
      return "text/plain; charset=utf-8";
    case "md":
      return "text/markdown; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
  }
}

export function exportFileName(prompt: ExportPrompt, version: ExportVersion, format: ExportFormat): string {
  const slug = prompt.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "prompt";
  return `${slug}-v${version.version_number}.${format}`;
}

/** Choose a fence longer than any backtick run inside the text. */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

export function renderExport(prompt: ExportPrompt, version: ExportVersion, format: ExportFormat, exportedAt = new Date()): string {
  switch (format) {
    case "txt":
      return version.prompt_text.endsWith("\n") ? version.prompt_text : `${version.prompt_text}\n`;
    case "md": {
      const fence = fenceFor(version.prompt_text);
      const summary = version.change_summary.length
        ? `\n## Changes in this version\n\n${version.change_summary.map((c) => `- ${c}`).join("\n")}\n`
        : "";
      return [
        `# ${prompt.title}`,
        "",
        `- Category: ${prompt.category}`,
        `- Version: ${version.version_number} (${version.provenance})`,
        `- Tags: ${prompt.tags.length ? prompt.tags.join(", ") : "none"}`,
        `- Exported: ${exportedAt.toISOString()}`,
        "",
        "## Prompt",
        "",
        `${fence}text`,
        version.prompt_text,
        fence,
        summary,
        "",
        "_Exported from PromptIQ. Token counts are estimates; this prompt has not been tested against its target model._",
        "",
      ].join("\n");
    }
    case "json": {
      const doc: PromptExportDocument = {
        format: "promptiq.prompt",
        format_version: 1,
        exported_at: exportedAt.toISOString(),
        prompt,
        version,
      };
      return `${JSON.stringify(doc, null, 2)}\n`;
    }
  }
}

/** Parse a JSON export produced by renderExport(…, "json"). */
export function parseJsonExport(text: string): PromptExportDocument {
  const value = JSON.parse(text) as Partial<PromptExportDocument>;
  if (value.format !== "promptiq.prompt" || value.format_version !== 1 || !value.prompt || !value.version) {
    throw new Error("Not a PromptIQ prompt export");
  }
  if (typeof value.version.prompt_text !== "string") throw new Error("Export is missing prompt text");
  return value as PromptExportDocument;
}

/** Recover the verbatim prompt text from a Markdown export. */
export function parseMarkdownExport(text: string): string {
  const match = text.match(/\n(`{3,})text\n([\s\S]*?)\n\1\n/);
  if (!match || match[2] === undefined) throw new Error("Not a PromptIQ Markdown export");
  return match[2];
}
