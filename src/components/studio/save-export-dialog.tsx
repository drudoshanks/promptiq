"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { CATEGORY_LABELS, TASK_CATEGORIES, type TaskCategory } from "@/lib/categories";
import { api, errorMessage, triggerDownload } from "@/lib/client/api";
import { recordFinalEstimate } from "@/lib/client/estimates";
import type { PromptDetailResponse, SerialisedVersion } from "@/lib/client/types";
import type { OutputLengthPreset } from "@/lib/config/estimates";
import { EXPORT_FORMATS, exportFileName, exportMimeType, renderExport, type ExportFormat } from "@/lib/export";

export interface SaveExportInput {
  originalText: string;
  proposedText: string;
  finalText: string;
  changeSummary: string[];
  category: TaskCategory;
  /** When the optimisation was auto-saved, new edits become versions of it. */
  savedPromptId: string | null;
  savedVersionIds: { original: string; optimised: string } | null;
  optimisationId: string;
  /** Model and answer-length assumption used for the final count recorded at export. */
  targetModel: string;
  outputPreset: OutputLengthPreset;
}

interface SaveExportDialogProps {
  open: boolean;
  mode: "save" | "export";
  onClose: () => void;
  input: SaveExportInput;
  onSaved: (prompt: PromptDetailResponse) => void;
}

const FORMAT_LABELS: Record<ExportFormat, string> = { txt: "Plain text (.txt)", md: "Markdown (.md)", json: "JSON (.json)" };

/** Save/export modal (§11): title, category, tags and format; exports round-trip exactly. */
export function SaveExportDialog({ open, mode, onClose, input, onSaved }: SaveExportDialogProps) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TaskCategory>(input.category);
  const [tags, setTags] = useState("");
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited = input.finalText.trim() !== input.proposedText.trim();

  async function save(): Promise<PromptDetailResponse | null> {
    setBusy(true);
    setError(null);
    try {
      if (input.savedPromptId && input.savedVersionIds) {
        // Already in the library: append the user's edit as a new version if it differs.
        if (edited) {
          await api<SerialisedVersion>(`/api/v1/prompts/${input.savedPromptId}/versions`, {
            method: "POST",
            body: {
              prompt_text: input.finalText,
              provenance: "user_edited",
              parent_version_id: input.savedVersionIds.optimised,
              change_summary: ["Edited by you after review."],
            },
          });
        }
        if (title.trim() || tags.trim()) {
          await api(`/api/v1/prompts/${input.savedPromptId}`, {
            method: "PATCH",
            body: {
              ...(title.trim() ? { title: title.trim() } : {}),
              ...(tags.trim() ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
              category,
            },
          });
        }
        const prompt = await api<PromptDetailResponse>(`/api/v1/prompts/${input.savedPromptId}`);
        onSaved(prompt);
        return prompt;
      }

      const versions = [
        { prompt_text: input.originalText, provenance: "original" },
        { prompt_text: input.proposedText, provenance: "ai_optimised", change_summary: input.changeSummary },
        ...(edited ? [{ prompt_text: input.finalText, provenance: "user_edited", change_summary: ["Edited by you after review."] }] : []),
      ];
      const prompt = await api<PromptDetailResponse>("/api/v1/prompts", {
        method: "POST",
        body: {
          title: title.trim() || undefined,
          category,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          versions,
        },
      });
      onSaved(prompt);
      return prompt;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function exportNow() {
    setBusy(true);
    setError(null);
    // The exported text is exactly the text counted here (§7, test 13).
    const exportText = input.finalText;
    let countNote: string | null = null;
    try {
      await recordFinalEstimate({
        model: input.targetModel,
        text: exportText,
        expectedOutput: input.outputPreset,
        runId: input.optimisationId,
        promptVersionId: !edited ? (input.savedVersionIds?.optimised ?? null) : null,
      });
    } catch (err) {
      // Counting is informational: never block the user's export on it.
      countNote = `Exported, but the final token count could not be recorded: ${errorMessage(err)}`;
    }
    const now = new Date();
    const prompt = {
      id: input.savedPromptId ?? "unsaved",
      title: title.trim() || input.finalText.split("\n")[0]?.slice(0, 80) || "Prompt",
      category,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const version = {
      id: "current",
      version_number: edited ? 3 : 2,
      provenance: edited ? "user_edited" : "ai_optimised",
      prompt_text: exportText,
      change_summary: input.changeSummary,
      created_at: now.toISOString(),
    };
    const body = renderExport(prompt, version, format, now);
    triggerDownload(new Blob([body], { type: exportMimeType(format) }), exportFileName(prompt, version, format));
    setBusy(false);
    if (countNote) setError(countNote);
    else onClose();
  }

  const isSave = mode === "save";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isSave ? (input.savedPromptId ? "Save your edit" : "Save to library") : "Export prompt"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {isSave ? (
            <Button variant="primary" loading={busy} onClick={() => void save().then((p) => p && onClose())}>
              {input.savedPromptId ? "Save version" : "Save prompt"}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void exportNow()}>
              Download {format.toUpperCase()}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {isSave && input.savedPromptId && !edited ? (
          <Alert tone="info">This optimisation is already in your library. Add a title or tags below, or edit the proposal first to save a new version.</Alert>
        ) : null}
        <Field label="Title" help={isSave ? "Leave blank to use the first line of the prompt." : "Used for the file name."}>
          {(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-describedby={p.describedBy} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            {(p) => (
              <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as TaskCategory)}>
                {TASK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {isSave ? (
            <Field label="Tags" help="Comma separated.">
              {(p) => <Input id={p.id} value={tags} onChange={(e) => setTags(e.target.value)} aria-describedby={p.describedBy} />}
            </Field>
          ) : (
            <Field label="Format">
              {(p) => (
                <Select id={p.id} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                  {EXPORT_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {!isSave ? (
          <p className="text-sm text-ink-soft">
            {edited ? "Exports your edited version." : "Exports the proposed version."} Exported prompts have not been tested against the model you will use them with.
          </p>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
