"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { TokenCostPanel } from "@/components/estimates/token-cost-panel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { CATEGORY_LABELS, PREFERENCE_LABELS, TASK_CATEGORIES, type PreferenceKey, type TaskCategory } from "@/lib/categories";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { ModelOption } from "@/lib/client/estimates";
import type { OptimisationResponse, PromptDetailResponse } from "@/lib/client/types";
import { DEFAULT_OUTPUT_PRESET, type OutputLengthPreset } from "@/lib/config/estimates";
import { diffStats, diffWords } from "@/lib/diff";
import { formatDate, formatNumber } from "@/lib/utils";

import { FeedbackPanel } from "./feedback-panel";
import { SaveExportDialog, type SaveExportInput } from "./save-export-dialog";

interface PromptStudioProps {
  initialText?: string;
  initialCategory?: TaskCategory | "auto";
  maxPromptChars: number;
  historyEnabled: boolean;
  personalisationEnabled: boolean;
  savedPreferenceCount: number;
  models: ModelOption[];
  defaultModel: string;
}

type Status = "idle" | "loading" | "done";

export function PromptStudio({ initialText = "", initialCategory = "auto", maxPromptChars, historyEnabled, personalisationEnabled, savedPreferenceCount, models, defaultModel }: PromptStudioProps) {
  const [text, setText] = useState(initialText);
  const [category, setCategory] = useState<TaskCategory | "auto">(initialCategory);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<OptimisationResponse | null>(null);
  const [finalText, setFinalText] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<{ message: string; code: string; details: Record<string, unknown> } | null>(null);
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<"save" | "export" | null>(null);
  const [savedPrompt, setSavedPrompt] = useState<PromptDetailResponse | null>(null);
  const [targetModel, setTargetModel] = useState(defaultModel);
  const [outputPreset, setOutputPreset] = useState<OutputLengthPreset>(DEFAULT_OUTPUT_PRESET);
  const resultsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const chars = text.length;
  const overLimit = chars > maxPromptChars;
  const stats = useMemo(() => (result ? diffStats(diffWords(result.original_prompt, finalText)) : null), [result, finalText]);
  const edited = result ? finalText.trim() !== result.optimised_prompt.trim() : false;

  useEffect(() => () => abortRef.current?.abort(), []);

  async function optimise() {
    if (!text.trim() || overLimit || status === "loading") return;
    setStatus("loading");
    setError(null);
    setCopied(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await api<OptimisationResponse>("/api/v1/optimisations", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: { prompt: text, task_category: category, options: { save_to_history: historyEnabled, target_model: targetModel, expected_output: outputPreset } },
        signal: controller.signal,
      });
      setResult(data);
      setFinalText(data.optimised_prompt);
      setEditing(false);
      setSavedPrompt(null);
      setStatus("done");
      requestAnimationFrame(() => resultsRef.current?.focus());
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const apiErr = err instanceof ApiError ? err : null;
      setError({ message: errorMessage(err), code: apiErr?.code ?? "UNKNOWN", details: apiErr?.details ?? {} });
      setStatus(result ? "done" : "idle");
    }
  }

  async function copyFinal() {
    try {
      await navigator.clipboard.writeText(finalText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError({ message: "Copy failed. Select the text and copy it manually.", code: "COPY_FAILED", details: {} });
    }
  }

  const saveInput: SaveExportInput | null = result
    ? {
        originalText: result.original_prompt,
        proposedText: result.optimised_prompt,
        finalText,
        changeSummary: result.change_summary,
        category: result.task_category,
        savedPromptId: savedPrompt?.id ?? result.saved_prompt_id,
        savedVersionIds: result.saved_version_ids,
        optimisationId: result.optimisation_id,
        targetModel,
        outputPreset,
      }
    : null;

  const applied = result ? (Object.entries(result.preferences_applied.effective) as Array<[PreferenceKey, string]>) : [];

  return (
    <div className="space-y-8">
      <section aria-labelledby="studio-heading" className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 id="studio-heading" className="text-2xl">
            Prompt studio
          </h1>
          <p className="text-sm text-ink-soft">
            {personalisationEnabled
              ? savedPreferenceCount > 0
                ? `${formatNumber(savedPreferenceCount)} saved ${savedPreferenceCount === 1 ? "preference applies" : "preferences apply"}.`
                : "No saved preferences yet."
              : "Saved preferences are switched off."}{" "}
            <Link href="/app/preferences">Manage</Link>
          </p>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void optimise();
          }}
        >
          <Field
            label="Your prompt"
            error={overLimit ? `This prompt is ${formatNumber(chars)} characters; your plan allows ${formatNumber(maxPromptChars)}. Shorten it or upgrade.` : null}
          >
            {(p) => (
              <Textarea
                id={p.id}
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the prompt you were about to send to ChatGPT or another assistant."
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                spellCheck={false}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-soft">
            <span>
              {formatNumber(chars)} / {formatNumber(maxPromptChars)} characters
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Kind of task" className="min-w-56">
              {(p) => (
                <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as TaskCategory | "auto")}>
                  <option value="auto">Detect automatically</option>
                  {TASK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" loading={status === "loading"} disabled={!text.trim() || overLimit}>
              {status === "loading" ? "Optimising" : "Optimise prompt"}
            </Button>
            {text ? (
              <Button type="button" variant="ghost" onClick={() => setText("")} disabled={status === "loading"}>
                Clear
              </Button>
            ) : null}
          </div>
        </form>

        {error ? <ErrorNotice error={error} onRetry={optimise} /> : null}
        {!historyEnabled ? <p className="mt-4 text-sm text-ink-soft">History is off: this optimisation is not stored unless you save it.</p> : null}
      </section>

      {!result || status === "idle" ? (
        <TokenCostPanel
          original={text}
          models={models}
          model={targetModel}
          onModelChange={setTargetModel}
          outputPreset={outputPreset}
          onOutputPresetChange={setOutputPreset}
        />
      ) : null}

      {result && status !== "idle" ? (
        <section ref={resultsRef} tabIndex={-1} aria-labelledby="results-heading" className="space-y-6 outline-none">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="results-heading" className="text-xl">
              Proposed rewrite
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              <Badge>{CATEGORY_LABELS[result.task_category]}</Badge>
              {stats ? (
                <span>
                  {stats.added} added, {stats.removed} removed
                </span>
              ) : null}
            </div>
          </div>

          {result.clarification_needed && result.clarifying_questions.length > 0 ? (
            <Alert tone="warning" title="A few details would make this rewrite more useful">
              <ul className="list-disc pl-5">
                {result.clarifying_questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm">The proposal below uses placeholders where the answer is needed. Edit it, or add the details to your prompt and run it again.</p>
            </Alert>
          ) : null}

          {editing ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="panel-soft p-4">
                <h3 className="mb-3 text-sm font-medium text-ink-soft">Original</h3>
                <div className="prompt-text">{result.original_prompt}</div>
              </section>
              <section className="panel p-4">
                <Field label="Your version" help="Edits are yours alone; the proposal stays available under Reset.">
                  {(p) => <Textarea id={p.id} rows={14} value={finalText} onChange={(e) => setFinalText(e.target.value)} aria-describedby={p.describedBy} spellCheck={false} />}
                </Field>
              </section>
            </div>
          ) : (
            <DiffView original={result.original_prompt} proposed={finalText} />
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={copyFinal}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy prompt"}
            </Button>
            <Button onClick={() => setEditing((v) => !v)}>{editing ? "Done editing" : "Edit proposal"}</Button>
            {edited ? (
              <Button variant="ghost" onClick={() => setFinalText(result.optimised_prompt)}>
                Reset to proposal
              </Button>
            ) : null}
            <Button onClick={() => setDialog("save")}>{savedPrompt || result.saved_prompt_id ? (edited ? "Save edit as version" : "Add title or tags") : "Save to library"}</Button>
            <Button onClick={() => setDialog("export")}>Export</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setText(result.original_prompt);
                setResult(null);
                setStatus("idle");
              }}
            >
              Use original instead
            </Button>
          </div>

          <TokenCostPanel
            original={result.original_prompt}
            optimised={finalText}
            models={models}
            model={targetModel}
            onModelChange={setTargetModel}
            outputPreset={outputPreset}
            onOutputPresetChange={setOutputPreset}
            actualUsage={result.actual_usage}
          />

          {savedPrompt || result.saved_prompt_id ? (
            <p className="text-sm text-ink-soft">
              Saved in your library{result.saved_prompt_id && !savedPrompt ? " automatically (history is on)" : ""}.{" "}
              <Link href={`/app/library/${savedPrompt?.id ?? result.saved_prompt_id}`}>Open it</Link>
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="panel p-5">
              <h3 className="text-base">What changed</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem]">
                {result.change_summary.length ? result.change_summary.map((c) => <li key={c}>{c}</li>) : <li>No changes were proposed.</li>}
              </ul>
              {result.assumptions.length ? (
                <>
                  <h3 className="mt-5 text-base">Assumptions made</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem]">
                    {result.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
            <div className="panel p-5">
              {result.quality_risks.length ? (
                <>
                  <h3 className="text-base">Watch out for</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem]">
                    {result.quality_risks.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <h3 className="text-base">Quality notes</h3>
                  <p className="mt-2 text-[0.9375rem] text-ink-soft">No specific risks were flagged. A clearer prompt is not proof of a better answer: test it with your model.</p>
                </>
              )}
              <h3 className="mt-5 text-base">Preferences applied</h3>
              {applied.length ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {applied.map(([key, value]) => (
                    <li key={key}>
                      <Badge title={`Source: ${result.preferences_applied.sources[key] ?? "request"}`}>
                        {PREFERENCE_LABELS[key]}: {value}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[0.9375rem] text-ink-soft">None. Anything you say in the prompt itself always wins over saved preferences.</p>
              )}
              <p className="mt-4 text-sm text-ink-faint">
                Optimised by {result.model_id}, template {result.template_version}, in {formatNumber(result.latency_ms)} ms.
              </p>
            </div>
          </div>

          <FeedbackPanel key={result.optimisation_id} optimisationId={result.optimisation_id} category={result.task_category} />
        </section>
      ) : null}

      {saveInput ? (
        <SaveExportDialog
          key={`${dialog}-${result?.optimisation_id}`}
          open={dialog !== null}
          mode={dialog ?? "save"}
          onClose={() => setDialog(null)}
          input={saveInput}
          onSaved={(prompt) => setSavedPrompt(prompt)}
        />
      ) : null}
    </div>
  );
}

function ErrorNotice({ error, onRetry }: { error: { message: string; code: string; details: Record<string, unknown> }; onRetry: () => void }) {
  const resetsAt = typeof error.details["resets_at"] === "string" ? (error.details["resets_at"] as string) : null;
  const upgrade = error.details["upgrade_available"] === true;
  const retryable = ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "INVALID_MODEL_OUTPUT", "RATE_LIMITED", "NETWORK_ERROR"].includes(error.code);

  let title: string | undefined;
  if (error.code === "QUOTA_EXCEEDED") title = "You have used this period's optimisations";
  if (error.code === "OPTIMISATION_REFUSED") title = "This prompt was not rewritten";
  if (error.code === "SPEND_CAP_REACHED") title = "Optimisation is paused for now";

  return (
    <Alert
      tone={error.code === "OPTIMISATION_REFUSED" ? "warning" : "error"}
      title={title}
      className="mt-4"
      action={
        <div className="flex flex-wrap gap-2">
          {retryable ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {upgrade ? (
            <Link href="/app/usage" className="btn btn-secondary btn-sm">
              See plans
            </Link>
          ) : null}
        </div>
      }
    >
      <p>
        {error.message}
        {resetsAt ? ` Your quota resets on ${formatDate(resetsAt)}.` : ""}
      </p>
      <p className="mt-1 text-sm">Your prompt text is unchanged.</p>
    </Alert>
  );
}
