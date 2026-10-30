"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { TokenCostPanel } from "@/components/estimates/token-cost-panel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { ModelOption } from "@/lib/client/estimates";
import type { OptimisationResponse } from "@/lib/client/types";
import { DEFAULT_OUTPUT_PRESET, type OutputLengthPreset } from "@/lib/config/estimates";
import type { SerialisedAnalysis, SerialisedSuggestion } from "@/lib/services/analysis";
import { cx, formatDateTime } from "@/lib/utils";

type Mode = "balanced" | "token_saver" | "quality_first" | "custom";

const MODES: Record<Mode, { label: string; hint: string }> = {
  balanced: { label: "Balanced", hint: "Clearer structure while removing unnecessary tokens." },
  token_saver: { label: "Token saver", hint: "Fewest tokens that keep every requirement and constraint." },
  quality_first: { label: "Quality first", hint: "Clarity and completeness first, even if longer." },
  custom: { label: "Custom", hint: "Your own objective." },
};

const STATUS_LABEL: Record<string, string> = {
  pending: "To review",
  accepted: "Accepted",
  dismissed: "Dismissed",
  deferred: "Later",
  applied: "Applied",
};

interface WorkspaceProps {
  promptId: string;
  currentVersion: { id: string; number: number; text: string };
  targetModel: string;
  defaultMode: Mode;
  models: ModelOption[];
  initialAnalysis: SerialisedAnalysis | null;
  initialSuggestions: SerialisedSuggestion[];
  analysedVersionNumber: number | null;
}

type Proposal = OptimisationResponse & { source_version_id: string; suggestion_ids: string[] };

/**
 * Suggestion and optimisation workflow for one saved prompt (Prompt Library §6):
 * analyse → review suggestions → optimise with a mode → edit → save as a new
 * version. The stored prompt is never overwritten automatically.
 */
export function PromptWorkspace(props: WorkspaceProps) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState(props.initialAnalysis);
  const [suggestions, setSuggestions] = useState(props.initialSuggestions);
  const [analysedVersion, setAnalysedVersion] = useState(props.analysedVersionNumber);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [busySuggestion, setBusySuggestion] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.initialSuggestions.filter((s) => s.status === "accepted").map((s) => s.id)));

  const [mode, setMode] = useState<Mode>(props.defaultMode);
  const [objective, setObjective] = useState("");
  const [targetModel, setTargetModel] = useState(props.targetModel);
  const [outputPreset, setOutputPreset] = useState<OutputLengthPreset>(DEFAULT_OUTPUT_PRESET);
  const [optimising, setOptimising] = useState(false);
  const [optimiseError, setOptimiseError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [finalText, setFinalText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const stale = analysis !== null && analysedVersion !== null && analysedVersion !== props.currentVersion.number;
  const actionable = useMemo(() => suggestions.filter((s) => s.status !== "dismissed" && s.status !== "applied"), [suggestions]);

  async function analyse(force: boolean) {
    setAnalysing(true);
    setAnalysisError(null);
    try {
      const result = await api<SerialisedAnalysis & { reused: boolean; suggestions: SerialisedSuggestion[] }>(`/api/v1/prompts/${props.promptId}/analyse`, {
        method: "POST",
        body: { force },
      });
      setAnalysis(result);
      setSuggestions(result.suggestions);
      setAnalysedVersion(props.currentVersion.number);
      setSelected(new Set(result.suggestions.filter((s) => s.status === "accepted").map((s) => s.id)));
      router.refresh();
    } catch (err) {
      setAnalysisError(errorMessage(err));
    } finally {
      setAnalysing(false);
    }
  }

  async function setStatus(s: SerialisedSuggestion, status: "pending" | "accepted" | "dismissed" | "deferred") {
    setBusySuggestion(s.id);
    try {
      const updated = await api<SerialisedSuggestion>(`/api/v1/suggestions/${s.id}`, { method: "PATCH", body: { status } });
      setSuggestions((list) => list.map((x) => (x.id === s.id ? { ...x, ...updated } : x)));
      setSelected((sel) => {
        const next = new Set(sel);
        if (status === "accepted") next.add(s.id);
        else next.delete(s.id);
        return next;
      });
    } catch (err) {
      setAnalysisError(errorMessage(err));
    } finally {
      setBusySuggestion(null);
    }
  }

  async function optimise() {
    setOptimising(true);
    setOptimiseError(null);
    setSavedMessage(null);
    try {
      const result = await api<Proposal>(`/api/v1/prompts/${props.promptId}/optimise`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: {
          version_id: props.currentVersion.id,
          mode,
          custom_objective: mode === "custom" ? objective : null,
          suggestion_ids: [...selected],
          target_model: targetModel,
          expected_output: outputPreset,
        },
      });
      setProposal(result);
      setFinalText(result.optimised_prompt);
    } catch (err) {
      setOptimiseError(err instanceof ApiError && err.code === "QUOTA_EXCEEDED" ? `${err.message} See Usage for your plan.` : errorMessage(err));
    } finally {
      setOptimising(false);
    }
  }

  async function saveVersion() {
    if (!proposal) return;
    setSaving(true);
    setOptimiseError(null);
    try {
      const edited = finalText.trim() !== proposal.optimised_prompt.trim();
      await api(`/api/v1/prompts/${props.promptId}/versions`, {
        method: "POST",
        body: {
          prompt_text: finalText,
          provenance: edited ? "user_edited" : "ai_optimised",
          parent_version_id: proposal.source_version_id,
          optimisation_id: proposal.optimisation_id,
          suggestion_ids: proposal.suggestion_ids,
          change_summary: edited ? [...proposal.change_summary, "Edited by you before saving."] : proposal.change_summary,
        },
      });
      setProposal(null);
      setSavedMessage("Saved as a new version. The previous versions are unchanged.");
      setSuggestions((list) => list.map((s) => (proposal.suggestion_ids.includes(s.id) ? { ...s, status: "applied" } : s)));
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setOptimiseError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section id="suggestions" aria-labelledby="suggestions-heading" className="panel scroll-mt-24 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="suggestions-heading" className="text-lg">
              Suggestions
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              An AI review of version {props.currentVersion.number}. Only this prompt is sent for review, and nothing changes until you save a new version.
            </p>
          </div>
          <Button variant={analysis ? "secondary" : "primary"} loading={analysing} onClick={() => analyse(Boolean(analysis) && !stale)}>
            {analysis ? (stale ? "Analyse current version" : "Analyse again") : "Analyse prompt"}
          </Button>
        </div>

        {analysisError ? (
          <Alert tone="error" className="mt-4">
            {analysisError}
          </Alert>
        ) : null}

        {analysis ? (
          <div className="mt-4 space-y-4">
            {stale ? <Alert tone="warning">These suggestions are for version {analysedVersion}. The current version is {props.currentVersion.number}; analyse it for up-to-date suggestions.</Alert> : null}
            <div className="flex flex-wrap items-center gap-3">
              {analysis.overall_quality_score !== null ? (
                <span className="text-2xl" title={analysis.score_note}>
                  {analysis.overall_quality_score}
                  <span className="text-base text-ink-faint">/100</span>
                </span>
              ) : null}
              <span className="text-sm text-ink-soft">{analysis.summary}</span>
            </div>
            <p className="text-sm text-ink-faint">The score is a heuristic indicator of clarity and completeness, not an objective measure of answer quality. Analysed {analysis.completed_at ? formatDateTime(analysis.completed_at) : ""}.</p>
            {analysis.already_well_optimised ? <Alert tone="success" title="Already well optimised">No meaningful improvement was found. You can still optimise for tokens or quality below.</Alert> : null}

            {suggestions.length ? (
              <ul className="space-y-3">
                {suggestions.map((s) => (
                  <li key={s.id} className={cx("rounded-[var(--radius-panel)] border border-line p-4", (s.status === "dismissed" || s.status === "applied") && "opacity-70")}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {s.status !== "dismissed" && s.status !== "applied" ? (
                            <input
                              type="checkbox"
                              aria-label={`Apply "${s.title}" when optimising`}
                              checked={selected.has(s.id)}
                              onChange={(e) =>
                                setSelected((sel) => {
                                  const next = new Set(sel);
                                  if (e.target.checked) next.add(s.id);
                                  else next.delete(s.id);
                                  return next;
                                })
                              }
                            />
                          ) : null}
                          <span className="font-medium">{s.title}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-sm">
                          <Badge tone={s.priority === "high" ? "danger" : "neutral"}>{s.priority}</Badge>
                          <Badge>{s.category_label}</Badge>
                          {s.token_direction && s.token_direction !== "neutral" ? (
                            <Badge tone="estimate">
                              {s.token_direction === "reduce" ? "fewer" : "more"} tokens{s.estimated_token_impact && s.estimated_token_impact !== "none" ? ` (${s.estimated_token_impact})` : ""}
                            </Badge>
                          ) : null}
                          <Badge tone={s.status === "accepted" || s.status === "applied" ? "accent" : "neutral"}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
                        </div>
                      </div>
                      {s.status !== "applied" ? (
                        <div className="flex flex-wrap gap-1" role="group" aria-label={`Decide on "${s.title}"`}>
                          <Button size="sm" variant={s.status === "accepted" ? "primary" : "secondary"} disabled={busySuggestion === s.id} onClick={() => setStatus(s, s.status === "accepted" ? "pending" : "accepted")}>
                            {s.status === "accepted" ? "Accepted" : "Accept"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busySuggestion === s.id} onClick={() => setStatus(s, s.status === "deferred" ? "pending" : "deferred")}>
                            {s.status === "deferred" ? "Undo later" : "Later"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busySuggestion === s.id} onClick={() => setStatus(s, s.status === "dismissed" ? "pending" : "dismissed")}>
                            {s.status === "dismissed" ? "Restore" : "Dismiss"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[0.9375rem]">{s.explanation}</p>
                    <p className="mt-1 text-[0.9375rem]">
                      <span className="text-ink-soft">Suggested change: </span>
                      {s.recommendation}
                    </p>
                    {s.requires_user_context && s.context_question ? (
                      <p className="mt-2 rounded-[var(--radius-control)] bg-info-soft px-3 py-2 text-sm text-info-ink">Needs your input: {s.context_question} Add the answer to the prompt before optimising; PromptIQ will not guess it.</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">Not analysed yet. Analysis uses one of your plan&apos;s analyses; re-analysing an unchanged version reuses the result.</p>
        )}
      </section>

      <section id="optimise" aria-labelledby="optimise-heading" className="panel scroll-mt-24 p-5">
        <h2 id="optimise-heading" className="text-lg">
          Optimise
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Creates a proposal from version {props.currentVersion.number}. Review and edit it, then save it as a new version. Your original is never changed.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <fieldset>
            <legend className="field-label">Mode</legend>
            <div className="space-y-2">
              {(Object.keys(MODES) as Mode[]).map((m) => (
                <label key={m} className="flex items-start gap-2 text-[0.9375rem]">
                  <input type="radio" name="mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
                  <span>
                    {MODES[m].label}
                    <span className="block text-sm text-ink-soft">{MODES[m].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-4">
            {mode === "custom" ? (
              <Field label="Your objective" help="For example: suitable for a 10-year-old, or keep it under 50 words.">
                {(p) => <Textarea id={p.id} rows={3} maxLength={500} value={objective} onChange={(e) => setObjective(e.target.value)} className="font-sans" aria-describedby={p.describedBy} />}
              </Field>
            ) : null}
            <div>
              <p className="field-label">Suggestions to apply</p>
              <p className="text-sm text-ink-soft">
                {selected.size === 0
                  ? actionable.length
                    ? "None selected. Tick suggestions above to apply them."
                    : "None. Analyse the prompt to get suggestions."
                  : `${selected.size} selected. They are marked applied only when you save the new version.`}
              </p>
            </div>
            <Field label="Target model">
              {(p) => (
                <Select id={p.id} value={targetModel} onChange={(e) => setTargetModel(e.target.value)}>
                  {props.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="primary" loading={optimising} disabled={mode === "custom" && !objective.trim()} onClick={optimise}>
              {proposal ? "Optimise again" : "Optimise prompt"}
            </Button>
          </div>
        </div>

        {optimiseError ? (
          <Alert tone="error" className="mt-4">
            {optimiseError}
          </Alert>
        ) : null}
        {savedMessage ? (
          <Alert tone="success" className="mt-4">
            {savedMessage}
          </Alert>
        ) : null}

        {proposal ? (
          <div className="mt-6 space-y-4">
            <h3 className="text-base">Proposal ({MODES[proposal.optimisation_mode as Mode]?.label ?? proposal.optimisation_mode})</h3>
            <DiffView original={proposal.original_prompt} proposed={finalText} />
            <Field label="Edit before saving" help="Your edits are saved with the version; counts update as you type.">
              {(p) => <Textarea id={p.id} rows={10} value={finalText} onChange={(e) => setFinalText(e.target.value)} aria-describedby={p.describedBy} spellCheck={false} />}
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="text-sm font-medium text-ink-soft">What changed</h4>
                <ul className="mt-1 list-disc pl-5 text-[0.9375rem]">
                  {proposal.change_summary.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              {proposal.quality_risks.length || proposal.clarifying_questions.length ? (
                <div>
                  <h4 className="text-sm font-medium text-ink-soft">Check before saving</h4>
                  <ul className="mt-1 list-disc pl-5 text-[0.9375rem]">
                    {[...proposal.clarifying_questions, ...proposal.quality_risks].map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <TokenCostPanel
              original={proposal.original_prompt}
              optimised={finalText}
              models={props.models}
              model={targetModel}
              onModelChange={setTargetModel}
              outputPreset={outputPreset}
              onOutputPresetChange={setOutputPreset}
              actualUsage={proposal.actual_usage}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={saving} disabled={!finalText.trim()} onClick={saveVersion}>
                Save as version {props.currentVersion.number + 1}
              </Button>
              <Button variant="ghost" onClick={() => setFinalText(proposal.optimised_prompt)} disabled={finalText === proposal.optimised_prompt}>
                Reset edits
              </Button>
              <Button variant="ghost" onClick={() => setProposal(null)}>
                Discard proposal
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
