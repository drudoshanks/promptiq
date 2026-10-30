"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Alert } from "@/components/ui/alert";
import { EstimateBadge, ProvenanceBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { CATEGORY_LABELS, TASK_CATEGORIES, type TaskCategory } from "@/lib/categories";
import { api, errorMessage, triggerDownload } from "@/lib/client/api";
import type { PromptDetailResponse, SerialisedVersion } from "@/lib/client/types";
import { EXPORT_FORMATS, exportFileName, exportMimeType, renderExport, type ExportFormat } from "@/lib/export";
import { formatDateTime, formatNumber } from "@/lib/utils";

interface PromptDetailProps {
  prompt: PromptDetailResponse;
  maxVersions: number;
}

export function PromptDetail({ prompt: initial, maxVersions }: PromptDetailProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initial);
  const versions = useMemo(() => [...prompt.versions].sort((a, b) => b.version_number - a.version_number), [prompt.versions]);
  const latest = versions[0] ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(latest?.id ?? null);
  const [compareId, setCompareId] = useState<string | null>(versions[1]?.id ?? null);
  const selected = versions.find((v) => v.id === selectedId) ?? latest;
  const compare = versions.find((v) => v.id === compareId) ?? null;

  const [title, setTitle] = useState(prompt.title);
  const [category, setCategory] = useState<TaskCategory>((prompt.category as TaskCategory) ?? "general");
  const [tags, setTags] = useState(prompt.tags.join(", "));
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaMessage, setMetaMessage] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [versionBusy, setVersionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("txt");

  async function saveMeta() {
    setMetaBusy(true);
    setMetaMessage(null);
    setError(null);
    try {
      const updated = await api<PromptDetailResponse>(`/api/v1/prompts/${prompt.id}`, {
        method: "PATCH",
        body: { title: title.trim() || prompt.title, category, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) },
      });
      setPrompt((p) => ({ ...p, ...updated, versions: p.versions }));
      setMetaMessage("Details saved.");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMetaBusy(false);
    }
  }

  async function toggleArchive() {
    setMetaBusy(true);
    setError(null);
    try {
      const updated = await api<PromptDetailResponse>(`/api/v1/prompts/${prompt.id}`, { method: "PATCH", body: { archived: !prompt.archived_at } });
      setPrompt((p) => ({ ...p, ...updated, versions: p.versions }));
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMetaBusy(false);
    }
  }

  async function addVersion(text: string, provenance: "user_edited" | "original", parentId: string | null, summary: string[]) {
    setVersionBusy(true);
    setError(null);
    try {
      const version = await api<SerialisedVersion>(`/api/v1/prompts/${prompt.id}/versions`, {
        method: "POST",
        body: { prompt_text: text, provenance, parent_version_id: parentId, change_summary: summary },
      });
      setPrompt((p) => ({ ...p, versions: [...p.versions, version] }));
      setSelectedId(version.id);
      setCompareId(parentId);
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVersionBusy(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api(`/api/v1/prompts/${prompt.id}`, { method: "DELETE" });
      router.push("/app/library");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(false);
    }
  }

  function exportSelected() {
    if (!selected) return;
    const body = renderExport(prompt, selected, format);
    triggerDownload(new Blob([body], { type: exportMimeType(format) }), exportFileName(prompt, selected, format));
  }

  async function copySelected() {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.prompt_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!selected) {
    return <Alert tone="error">This prompt has no versions.</Alert>;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-ink-soft">
            <Link href="/app/library">Library</Link>
          </p>
          <h1 className="mt-1 break-words">{prompt.title}</h1>
          <p className="mt-2 text-sm text-ink-soft">
            {versions.length} of {maxVersions} versions. Versions are immutable; editing creates a new one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/app/studio?prompt=${prompt.id}&version=${selected.id}`} className="btn btn-primary">
            Optimise again
          </Link>
          <Button onClick={toggleArchive} loading={metaBusy}>
            {prompt.archived_at ? "Unarchive" : "Archive"}
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-ink-soft" htmlFor="version-select">
              Showing
            </label>
            <Select id="version-select" className="w-auto" value={selected.id} onChange={(e) => setSelectedId(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version_number} ({v.provenance.replace("_", " ")})
                </option>
              ))}
            </Select>
            <label className="text-sm text-ink-soft" htmlFor="compare-select">
              compared with
            </label>
            <Select id="compare-select" className="w-auto" value={compare?.id ?? ""} onChange={(e) => setCompareId(e.target.value || null)}>
              <option value="">nothing</option>
              {versions
                .filter((v) => v.id !== selected.id)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.version_number}
                  </option>
                ))}
            </Select>
          </div>

          {editing ? (
            <div className="panel p-4">
              <Field label={`Edit version ${selected.version_number} as a new version`}>
                {(p) => <Textarea id={p.id} rows={14} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />}
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" loading={versionBusy} disabled={!draft.trim() || draft.trim() === selected.prompt_text.trim()} onClick={() => addVersion(draft, "user_edited", selected.id, ["Edited by you."])}>
                  Save as new version
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : compare ? (
            <DiffView original={compare.prompt_text} proposed={selected.prompt_text} />
          ) : (
            <section className="panel p-4">
              <div className="prompt-text">{selected.prompt_text}</div>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={copySelected}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : `Copy version ${selected.version_number}`}
            </Button>
            {!editing ? (
              <Button
                onClick={() => {
                  setDraft(selected.prompt_text);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
            {latest && selected.id !== latest.id ? (
              <Button loading={versionBusy} onClick={() => addVersion(selected.prompt_text, "user_edited", selected.id, [`Restored from version ${selected.version_number}.`])}>
                Restore as latest
              </Button>
            ) : null}
            <span className="ml-auto inline-flex items-center gap-2">
              <Select aria-label="Export format" className="w-auto" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                {EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    .{f}
                  </option>
                ))}
              </Select>
              <Button onClick={exportSelected}>Export</Button>
            </span>
          </div>

          <div className="panel-soft p-4 text-sm text-ink-soft">
            <div className="flex flex-wrap items-center gap-2">
              <ProvenanceBadge provenance={selected.provenance} />
              <span>Created {formatDateTime(selected.created_at)}</span>
              {selected.token_estimate !== null && selected.token_estimate !== undefined ? (
                <span className="inline-flex items-center gap-2">
                  about {formatNumber(selected.token_estimate)} tokens <EstimateBadge method={selected.token_estimate_method} />
                </span>
              ) : null}
            </div>
            {selected.change_summary.length ? (
              <ul className="mt-2 list-disc pl-5 text-ink">
                {selected.change_summary.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <aside className="space-y-5">
          <div className="panel p-4">
            <h2 className="text-base">Details</h2>
            <div className="mt-3 space-y-3">
              <Field label="Title">{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />}</Field>
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
              <Field label="Tags" help="Comma separated.">
                {(p) => <Input id={p.id} value={tags} onChange={(e) => setTags(e.target.value)} aria-describedby={p.describedBy} />}
              </Field>
              {metaMessage ? <p className="text-sm text-accent-deep">{metaMessage}</p> : null}
              <Button size="sm" loading={metaBusy} onClick={saveMeta}>
                Save details
              </Button>
            </div>
          </div>

          <div className="panel p-4">
            <h2 className="text-base">Versions</h2>
            <ol className="mt-3 space-y-2 text-sm">
              {versions.map((v) => (
                <li key={v.id}>
                  <button type="button" className={`w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left ${v.id === selected.id ? "bg-accent-soft" : "hover:bg-panel-soft"}`} onClick={() => setSelectedId(v.id)} aria-current={v.id === selected.id ? "true" : undefined}>
                    <span className="font-medium">Version {v.version_number}</span>
                    <span className="ml-2 text-ink-soft">{v.provenance.replace("_", " ")}</span>
                    <span className="block text-ink-faint">{formatDateTime(v.created_at)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this prompt?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Keep it
            </Button>
            <Button variant="danger" loading={deleting} onClick={remove}>
              Delete prompt and {versions.length} {versions.length === 1 ? "version" : "versions"}
            </Button>
          </>
        }
      >
        <p>This removes the prompt and every version from your library. Export it first if you want a copy.</p>
      </Dialog>
    </div>
  );
}
