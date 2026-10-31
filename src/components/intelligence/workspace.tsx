"use client";

import { Check, Copy, Download, PencilLine, RotateCcw, Sparkles, ThumbsDown, ThumbsUp, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Alert } from "@/components/ui/alert";
import { Badge, EstimateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { api, errorMessage, triggerDownload } from "@/lib/client/api";
import { GENERATION_MODE_LABELS, GENERATION_MODES, INTENT_CATEGORIES, INTENT_LABELS, TO_TASK_CATEGORY, type GenerationMode, type IntentCategory } from "@/lib/intelligence/categories";
import { formatMoney } from "@/lib/money";
import type { IntelligenceAnalysis, IntelligenceRevision } from "@/lib/services/intelligence";
import { cx, formatNumber } from "@/lib/utils";

import { PreservationPanel, PRESERVATION_BADGE, type PreservationView } from "./preservation-panel";
import { RubricBar } from "./rubric-bar";

type Suggestion = IntelligenceAnalysis["suggestions"][number];
type Status = "pending" | "accepted" | "dismissed" | "deferred" | "applied";

export interface WorkspacePrompt {
  id: string;
  title: string;
  versionId: string;
  versionNumber: number;
  text: string;
}

interface WorkspaceProps {
  models: Array<{ id: string; label: string }>;
  defaultModel: string;
  defaultMode: GenerationMode;
  /** A saved prompt to work on; results are saved as its next version. */
  prompt?: WorkspacePrompt | null;
  initialAnalysis?: IntelligenceAnalysis | null;
  /** Embedded on a prompt page: no page heading, editor collapsed by default. */
  embedded?: boolean;
}

const PRIORITY_TONE = { high: "danger", medium: "warn", low: "neutral" } as const;

function recommendationOf(s: Suggestion): string {
  const x = s as { recommended_change?: string; recommendation?: string; title: string };
  return x.recommended_change ?? x.recommendation ?? x.title;
}

function signed(n: number) {
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

export function IntelligenceWorkspace({ models, defaultModel, defaultMode, prompt, initialAnalysis = null, embedded = false }: WorkspaceProps) {
  const router = useRouter();
  const [text, setText] = useState(prompt?.text ?? "");
  const [category, setCategory] = useState<IntentCategory | "auto">("auto");
  const [model, setModel] = useState(defaultModel);
  const [mode, setMode] = useState<GenerationMode>(defaultMode);
  const [budget, setBudget] = useState("");
  const [objective, setObjective] = useState("");

  const [analysis, setAnalysis] = useState<IntelligenceAnalysis | null>(initialAnalysis);
  const [statuses, setStatuses] = useState<Record<string, Status>>(() => Object.fromEntries((initialAnalysis?.suggestions ?? []).map((s) => [s.id, s.status as Status])));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [assumptions, setAssumptions] = useState<string[]>(initialAnalysis?.assumptions ?? []);

  const [revisions, setRevisions] = useState<IntelligenceRevision[]>([]);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  const [editCheck, setEditCheck] = useState<{ preservation: PreservationView; tokens: number } | null>(null);
  const [view, setView] = useState<"side" | "diff">("side");
  const [mobilePane, setMobilePane] = useState<"original" | "proposed">("proposed");

  const [busy, setBusy] = useState<null | "analyse" | "detailed" | "optimise" | "apply" | "again" | "validate" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rated, setRated] = useState<Record<string, 1 | -1>>({});
  const lastRequest = useRef<{ endpoint: string; body: Record<string, unknown> } | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const revision = revisions[active] ?? null;
  const textIsSaved = Boolean(prompt) && text === prompt?.text;
  const stale = analysis !== null && !textIsSaved && analysis.prompt_version_id !== null;
  const finalText = editing ? edited : (revision?.revised_prompt ?? "");

  const source = () => (prompt ? { prompt_id: prompt.id, version_id: prompt.versionId, ...(textIsSaved ? {} : { prompt_text: text }) } : { prompt_text: text });

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function analyse(force = false) {
    const result = await run("analyse", () =>
      api<IntelligenceAnalysis>("/api/v1/prompt-intelligence/analyse", { method: "POST", body: { ...source(), category: category === "auto" ? null : category, target_model: model, force } }),
    );
    if (!result) return;
    setAnalysis(result);
    setStatuses(Object.fromEntries(result.suggestions.map((s) => [s.id, s.status as Status])));
    setSelected(new Set());
    setAssumptions(result.assumptions);
    setAnswers({});
    if (category === "auto" && result.classification.method === "user") setCategory(result.classification.primary);
  }

  function acceptedPayload(ids: Set<string>) {
    const chosen = (analysis?.suggestions ?? []).filter((s) => ids.has(s.id));
    return {
      suggestion_ids: chosen.filter((s) => s.persisted).map((s) => s.id),
      accepted_changes: chosen.filter((s) => !s.persisted).map((s) => ({ category: s.category, text: recommendationOf(s) })),
    };
  }

  async function revise(kind: "detailed" | "optimise" | "apply", modeOverride?: GenerationMode, ids: Set<string> = selected) {
    const useMode = modeOverride ?? mode;
    const endpoint = useMode === "detailed" ? "/api/v1/prompt-intelligence/generate" : "/api/v1/prompt-intelligence/optimise";
    const body: Record<string, unknown> = {
      ...source(),
      mode: useMode,
      category: category === "auto" ? (analysis?.classification.primary ?? null) : category,
      target_model: model,
      token_budget: budget.trim() ? Number(budget) : null,
      // An answered question replaces its "not specified" assumption.
      assumptions: assumptions.filter((a) => a.trim() && !(analysis?.clarification_questions ?? []).some((q) => answers[q.key]?.trim() && a.startsWith(`${q.label}:`))),
      answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())),
      custom_objective: useMode === "custom" ? objective : null,
      ...acceptedPayload(ids),
    };
    lastRequest.current = { endpoint, body };
    const result = await run(kind, () => api<IntelligenceRevision>(endpoint, { method: "POST", body }));
    if (!result) return;
    pushRevision(result, ids);
  }

  function pushRevision(result: IntelligenceRevision, ids: Set<string>) {
    setRevisions((list) => {
      const next = [...list, result];
      setActive(next.length - 1);
      return next;
    });
    setEditing(false);
    setEditCheck(null);
    if (ids.size) setStatuses((s) => ({ ...s, ...Object.fromEntries([...ids].map((id) => [id, "accepted" as Status])) }));
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function again() {
    if (!lastRequest.current) return;
    const { endpoint, body } = lastRequest.current;
    const result = await run("again", () => api<IntelligenceRevision>(endpoint, { method: "POST", body }));
    if (result) pushRevision(result, new Set());
  }

  async function setSuggestionStatus(s: Suggestion, status: Exclude<Status, "applied">) {
    const previous = statuses[s.id];
    setStatuses((m) => ({ ...m, [s.id]: status }));
    if (status !== "accepted") setSelected((sel) => new Set([...sel].filter((id) => id !== s.id)));
    else setSelected((sel) => new Set([...sel, s.id]));
    try {
      if (s.persisted) {
        await api(`/api/v1/suggestions/${s.id}`, { method: "PATCH", body: { status } });
      } else if (status === "dismissed" || status === "deferred") {
        await api("/api/v1/prompt-intelligence/feedback", { method: "POST", body: { event_type: status === "dismissed" ? "suggestion_dismissed" : "suggestion_deferred", suggestion_category: s.category, task_category: analysis?.classification.primary ?? null } });
      }
    } catch (err) {
      setStatuses((m) => ({ ...m, [s.id]: previous ?? "pending" }));
      setError(errorMessage(err));
    }
  }

  async function checkEdits() {
    if (!revision) return;
    const result = await run("validate", () =>
      api<{ preservation: PreservationView; estimate: IntelligenceRevision["estimate"] }>("/api/v1/prompt-intelligence/validate", { method: "POST", body: { original: revision.original_prompt, revised: edited, target_model: model } }),
    );
    if (result) setEditCheck({ preservation: result.preservation, tokens: result.estimate.optimised.token_count });
  }

  async function save() {
    if (!revision) return;
    const isEdited = editing && edited !== revision.revised_prompt;
    const result = await run("save", async () => {
      if (prompt) {
        const version = await api<{ id: string; version_number: number }>(`/api/v1/prompts/${prompt.id}/versions`, {
          method: "POST",
          body: {
            prompt_text: finalText,
            optimisation_id: revision.revision_id,
            provenance: isEdited ? "user_edited" : "ai_optimised",
            change_summary: revision.key_improvements.slice(0, 6),
            suggestion_ids: revision.suggestion_ids,
          },
        });
        return { kind: "version" as const, version };
      }
      const created = await api<{ id: string }>("/api/v1/prompts", {
        method: "POST",
        body: {
          category: TO_TASK_CATEGORY[revision.category as IntentCategory] ?? "general",
          target_model: model,
          versions: [
            { prompt_text: revision.original_prompt, provenance: "original" },
            { prompt_text: finalText, provenance: isEdited ? "user_edited" : "ai_optimised", change_summary: revision.key_improvements.slice(0, 6) },
          ],
        },
      });
      return { kind: "prompt" as const, id: created.id };
    });
    if (!result) return;
    if (result.kind === "version") {
      setNotice(`Saved as version ${result.version.version_number}. The original is unchanged in the history.`);
      router.refresh();
    } else {
      router.push(`/app/library/${result.id}`);
    }
  }

  async function rate(value: 1 | -1) {
    if (!revision) return;
    setRated((r) => ({ ...r, [revision.revision_id]: value }));
    try {
      await api(`/api/v1/optimisations/${revision.revision_id}/feedback`, { method: "POST", body: { rating: value } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(finalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function exportFile(ext: "md" | "txt") {
    const name = (prompt?.title ?? analysis?.classification.objective ?? "prompt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "prompt";
    triggerDownload(new Blob([finalText], { type: ext === "md" ? "text/markdown" : "text/plain" }), `${name}.${ext}`);
  }

  const visibleSuggestions = useMemo(() => (analysis?.suggestions ?? []).filter((s) => statuses[s.id] !== "dismissed"), [analysis, statuses]);
  const dismissedCount = (analysis?.suggestions.length ?? 0) - visibleSuggestions.length;
  const canRun = text.trim().length > 0 && busy === null;

  return (
    <div className="space-y-6">
      {!embedded ? (
        <header className="max-w-3xl">
          <h1>Prompt intelligence</h1>
          <p className="mt-2 text-ink-soft">
            Analyse a prompt, see exactly what it is missing, then generate a detailed or a token-efficient version. Every requirement you wrote is checked in the result, and nothing is saved until you choose to.
          </p>
        </header>
      ) : null}

      {error ? (
        <Alert tone="error" action={<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>
          {error}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Input */}
        <section aria-labelledby="input-heading" className="panel h-fit p-5 xl:sticky xl:top-6">
          <div className="flex items-center justify-between gap-2">
            <h2 id="input-heading" className="text-lg">
              {prompt ? `Version ${prompt.versionNumber}` : "Your prompt"}
            </h2>
            {prompt && !textIsSaved ? <Badge tone="warn">Edited, not saved</Badge> : null}
          </div>
          <Field label="Prompt" className="mt-3">
            {(p) => <Textarea id={p.id} value={text} onChange={(e) => setText(e.target.value)} rows={embedded ? 7 : 10} placeholder="For example: Build an ecommerce website for my bakery" spellCheck />}
          </Field>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Task category" help={analysis && category === "auto" ? `Detected: ${analysis.classification.primary_label}` : undefined}>
              {(p) => (
                <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as IntentCategory | "auto")} aria-describedby={p.describedBy}>
                  <option value="auto">Detect automatically</option>
                  {INTENT_CATEGORIES.filter((c) => c !== "unknown").map((c) => (
                    <option key={c} value={c}>
                      {INTENT_LABELS[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Target model">
              {(p) => (
                <Select id={p.id} value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className="field-label">Optimisation mode</legend>
            <div className="segmented grid w-full grid-cols-3" role="group" aria-label="Optimisation mode">
              {GENERATION_MODES.map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={GENERATION_MODE_LABELS[m].description}>
                  {GENERATION_MODE_LABELS[m].label}
                </button>
              ))}
            </div>
            <p className="field-help">{GENERATION_MODE_LABELS[mode].description}</p>
          </fieldset>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Token budget (optional)" help="Never met by dropping a requirement.">
              {(p) => <Input id={p.id} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 150" aria-describedby={p.describedBy} />}
            </Field>
            {mode === "custom" ? (
              <Field label="Your objective">
                {(p) => <Input id={p.id} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={500} placeholder="e.g. Make it suitable for a junior developer" />}
              </Field>
            ) : null}
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <Button className="whitespace-normal" variant="secondary" onClick={() => analyse(false)} loading={busy === "analyse"} disabled={!canRun}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Analyse prompt
            </Button>
            <Button className="whitespace-normal" variant="secondary" onClick={() => revise("detailed", "detailed")} loading={busy === "detailed"} disabled={!canRun}>
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              Generate detailed prompt
            </Button>
            <Button className="sm:col-span-2" variant="primary" onClick={() => revise("optimise", mode)} loading={busy === "optimise"} disabled={!canRun || (mode === "custom" && !objective.trim())}>
              Optimise prompt
            </Button>
          </div>
          {analysis?.token_estimate ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              {formatNumber(analysis.token_estimate.token_count)} tokens for {analysis.token_estimate.model}
              {analysis.token_estimate.cost ? ` · about ${formatMoney(analysis.token_estimate.cost.input_cost)} input cost` : ""}
              <EstimateBadge method="tokenizer" />
            </p>
          ) : null}
        </section>

        {/* Analysis */}
        <section aria-labelledby="analysis-heading" aria-busy={busy === "analyse"} className="space-y-6">
          {!analysis ? (
            <div className="panel-soft grid min-h-64 place-items-center p-8 text-center">
              <div className="max-w-sm">
                <h2 id="analysis-heading" className="text-lg">
                  Start with an analysis
                </h2>
                <p className="mt-2 text-sm text-ink-soft">
                  PromptIQ identifies the task, scores how completely the prompt states its goal, context and requirements, and lists what to add. It takes a few seconds and doesn&apos;t change your text.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="analysis-heading" className="text-lg">
                      {analysis.classification.primary_label}
                      {analysis.classification.secondary_label ? <span className="font-normal text-ink-soft"> with {analysis.classification.secondary_label.toLowerCase()}</span> : null}
                    </h2>
                    <p className="mt-1 text-sm text-ink-soft">
                      {analysis.classification.method === "user" ? "Category chosen by you" : `${Math.round(analysis.classification.confidence * 100)}% confidence, ${analysis.classification.method === "model" ? "classified by the model" : "matched by rules"}`} · template: {analysis.classification.template.label}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {stale ? <Badge tone="warn">Prompt changed since analysis</Badge> : null}
                    {analysis.is_current === false ? <Badge tone="warn">Older version</Badge> : null}
                    {analysis.score.sufficiently_clear ? <Badge tone="accent">Sufficiently clear</Badge> : null}
                    {analysis.score.needs_more_context ? <Badge tone="estimate">More context needed</Badge> : null}
                  </div>
                </div>
                {analysis.classification.objective ? (
                  <p className="mt-4 rounded-lg bg-accent-faint px-3 py-2 text-[0.9375rem]">
                    <span className="text-ink-soft">Objective: </span>
                    {analysis.classification.objective}
                  </p>
                ) : null}
                <div className="mt-5">
                  <RubricBar overall={analysis.score.overall} dimensions={analysis.score.dimensions as never} note={analysis.score.note} />
                </div>
                {stale ? (
                  <Button size="sm" className="mt-4" onClick={() => analyse(true)} loading={busy === "analyse"}>
                    Re-analyse the edited prompt
                  </Button>
                ) : null}
              </div>

              {/* Suggestions */}
              <div className="panel p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base">Suggestions</h3>
                  {visibleSuggestions.length ? (
                    <Button size="sm" variant="primary" disabled={selected.size === 0 || busy !== null} loading={busy === "apply"} onClick={() => revise("apply", mode)}>
                      Apply {selected.size || ""} selected
                    </Button>
                  ) : null}
                </div>
                {analysis.already_well_optimised && visibleSuggestions.length === 0 ? (
                  <p className="mt-3 rounded-lg bg-accent-soft px-3 py-3 text-sm text-accent-deep">Already well optimised. The goal, requirements and expected output are clear; there is nothing worth changing.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {visibleSuggestions.map((s) => {
                      const status = statuses[s.id] ?? "pending";
                      const isSelected = selected.has(s.id);
                      const recommended = recommendationOf(s);
                      const impact = (s as { estimated_token_impact?: number | null; token_impact?: number | null }).token_impact ?? (typeof s.estimated_token_impact === "number" ? s.estimated_token_impact : null);
                      return (
                        <li key={s.id} className={cx("rounded-lg border p-3 transition-colors", isSelected ? "border-accent bg-accent-faint" : "border-line", status === "deferred" && "opacity-70")}>
                          <div className="flex gap-3">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 flex-none accent-[var(--color-accent)]"
                              checked={isSelected}
                              disabled={status === "applied"}
                              onChange={(e) => setSelected((sel) => (e.target.checked ? new Set([...sel, s.id]) : new Set([...sel].filter((id) => id !== s.id))))}
                              aria-label={`Select: ${s.title}`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="font-medium">{s.title}</p>
                                <Badge tone={PRIORITY_TONE[s.priority as keyof typeof PRIORITY_TONE] ?? "neutral"}>{s.priority}</Badge>
                                <Badge>{s.category_label}</Badge>
                                {impact !== null && impact !== 0 ? <Badge tone="estimate">{signed(impact)} tokens</Badge> : null}
                                {status !== "pending" ? <Badge tone={status === "accepted" || status === "applied" ? "accent" : "neutral"}>{status}</Badge> : null}
                              </div>
                              <p className="mt-1 text-sm text-ink-soft">{s.explanation}</p>
                              <p className="mt-1.5 text-sm">
                                <span className="font-medium">Change: </span>
                                {recommended}
                              </p>
                              {s.expected_benefit ? <p className="mt-0.5 text-sm text-ink-soft">Benefit: {s.expected_benefit}</p> : null}
                              {"ranking" in s && s.ranking && typeof s.ranking === "object" && "explanation" in s.ranking && (Number((s.ranking as { feedback_events?: number }).feedback_events) > 0 || Number((s.ranking as { preference_match?: number }).preference_match) >= 0.8) ? (
                                <p className="mt-1 text-[0.8125rem] text-ink-faint">Ranked for you: {String((s.ranking as { explanation: string }).explanation)}</p>
                              ) : null}
                              {status !== "applied" ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  <Button size="sm" variant="ghost" onClick={() => setSuggestionStatus(s, "accepted")} disabled={status === "accepted"}>
                                    Accept
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setSuggestionStatus(s, "deferred")} disabled={status === "deferred"}>
                                    Later
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setSuggestionStatus(s, "dismissed")}>
                                    Dismiss
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {dismissedCount > 0 ? <p className="mt-2 text-[0.8125rem] text-ink-faint">{dismissedCount} dismissed. Dismissals make similar suggestions rank lower for you.</p> : null}
              </div>

              {/* Clarifications and assumptions */}
              {analysis.clarification_questions.length || assumptions.length ? (
                <div className="panel p-5">
                  <h3 className="text-base">Missing information</h3>
                  <p className="mt-1 text-sm text-ink-soft">Answer what you can. Unanswered items become labelled assumptions in the generated prompt, which you can edit or remove. Nothing is invented.</p>
                  <div className="mt-4 space-y-3">
                    {analysis.clarification_questions.map((q) => (
                      <Field key={q.key} label={q.label} help={q.question}>
                        {(p) => <Input id={p.id} value={answers[q.key] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))} aria-describedby={p.describedBy} maxLength={1000} />}
                      </Field>
                    ))}
                  </div>
                  {assumptions.length ? (
                    <div className="mt-5">
                      <p className="field-label">Editable assumptions</p>
                      <ul className="space-y-2">
                        {assumptions.map((a, i) => (
                          <li key={i} className="flex gap-2">
                            <Input value={a} onChange={(e) => setAssumptions((list) => list.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Assumption ${i + 1}`} maxLength={400} />
                            <Button size="sm" variant="ghost" onClick={() => setAssumptions((list) => list.filter((_, j) => j !== i))} aria-label={`Remove assumption ${i + 1}`}>
                              <X className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAssumptions((list) => [...list, ""])} disabled={assumptions.length >= 12}>
                        Add an assumption
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {/* Results */}
      {revision ? (
        <section ref={resultsRef} aria-labelledby="results-heading" className="panel scroll-mt-6 p-5" aria-busy={busy === "again"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="results-heading" className="text-lg">
                Proposed prompt
              </h2>
              <p className="text-sm text-ink-soft">
                {GENERATION_MODE_LABELS[revision.mode].label} · {revision.template.label} template · {revision.engine === "local" ? "rule-based, no model call" : `${revision.iterations} revision round${revision.iterations === 1 ? "" : "s"}`}
                {revision.repaired ? " · requirements re-added" : ""}
              </p>
            </div>
            {revisions.length > 1 ? (
              <div className="segmented" role="tablist" aria-label="Generated versions">
                {revisions.map((r, i) => (
                  <button key={r.revision_id} type="button" role="tab" aria-selected={i === active} onClick={() => { setActive(i); setEditing(false); setEditCheck(null); }}>
                    Draft {i + 1}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Stats */}
          <dl className="mt-5 grid grid-cols-2 gap-4 border-y border-line py-4 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <dt className="stat-label">Original</dt>
              <dd className="stat-value">{formatNumber(revision.estimate.original.token_count)}</dd>
            </div>
            <div>
              <dt className="stat-label">Proposed</dt>
              <dd className="stat-value">{formatNumber(editing && editCheck ? editCheck.tokens : revision.estimate.optimised.token_count)}</dd>
            </div>
            <div>
              <dt className="stat-label">{revision.estimate.tokens_saved >= 0 ? "Tokens saved" : "Tokens added"}</dt>
              <dd className={cx("stat-value", revision.estimate.tokens_saved >= 0 ? "text-accent-deep" : "text-estimate")}>
                {formatNumber(Math.abs(revision.estimate.tokens_saved))}
                <span className="ml-1 text-sm font-normal text-ink-soft">{revision.estimate.reduction_percent >= 0 ? "−" : "+"}{Math.abs(revision.estimate.reduction_percent).toFixed(1)}%</span>
              </dd>
            </div>
            <div>
              <dt className="stat-label">Input cost per run</dt>
              <dd className="stat-value text-base sm:text-[1.375rem]">
                {revision.estimate.cost ? `${revision.estimate.cost.input_cost_difference >= 0 ? "−" : "+"}${formatMoney(Math.abs(revision.estimate.cost.input_cost_difference))}` : "No pricing"}
              </dd>
            </div>
            <div>
              <dt className="stat-label">Requirements</dt>
              <dd className="mt-1">
                <Badge tone={PRESERVATION_BADGE[(editCheck?.preservation ?? revision.preservation).status].tone}>{PRESERVATION_BADGE[(editCheck?.preservation ?? revision.preservation).status].label}</Badge>
              </dd>
            </div>
          </dl>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-faint">
            Counted with the {revision.estimate.model} tokenizer. {revision.estimate.tokens_saved < 0 ? "The proposal is longer than the original; that is expected when detail is added." : ""}
            <EstimateBadge method="tokenizer" />
          </p>
          {revision.budget.requested ? (
            <Alert tone={revision.budget.met ? "success" : "warning"} className="mt-3" title={revision.budget.met ? `Within your ${revision.budget.requested}-token budget` : "Budget not met safely"}>
              {revision.budget.explanation ?? "Every requirement was kept."}
              {revision.budget.alternatives.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {revision.budget.alternatives.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}

          {/* Comparison */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="segmented" role="tablist" aria-label="Comparison view">
              <button type="button" role="tab" aria-selected={view === "side"} onClick={() => setView("side")}>
                Side by side
              </button>
              <button type="button" role="tab" aria-selected={view === "diff"} onClick={() => setView("diff")}>
                Changes
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {!editing ? (
                <Button size="sm" variant="ghost" onClick={() => { setEditing(true); setEdited(revision.revised_prompt); }}>
                  <PencilLine className="h-4 w-4" aria-hidden="true" />
                  Edit
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setEditCheck(null); }}>
                  Discard edits
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={copy}>
                {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => exportFile("md")}>
                <Download className="h-4 w-4" aria-hidden="true" />
                .md
              </Button>
              <Button size="sm" variant="ghost" onClick={() => exportFile("txt")}>
                .txt
              </Button>
            </div>
          </div>

          {view === "side" ? (
            <>
              <div className="mt-3 lg:hidden">
                <div className="segmented" role="tablist" aria-label="Which prompt to show">
                  <button type="button" role="tab" aria-selected={mobilePane === "original"} onClick={() => setMobilePane("original")}>
                    Original
                  </button>
                  <button type="button" role="tab" aria-selected={mobilePane === "proposed"} onClick={() => setMobilePane("proposed")}>
                    Proposed
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                <div className={cx(mobilePane !== "original" && "hidden lg:block")}>
                  <p className="mb-1.5 text-sm font-medium text-ink-soft">Original</p>
                  <div className="prompt-text max-h-[32rem] overflow-auto rounded-lg border border-line bg-panel-soft p-4">{revision.original_prompt}</div>
                </div>
                <div className={cx(mobilePane !== "proposed" && "hidden lg:block")}>
                  <p className="mb-1.5 text-sm font-medium text-accent-deep">Proposed{editing ? " (editing)" : ""}</p>
                  {editing ? (
                    <Textarea value={edited} onChange={(e) => { setEdited(e.target.value); setEditCheck(null); }} rows={16} aria-label="Edit the proposed prompt" />
                  ) : (
                    <div className="prompt-text max-h-[32rem] overflow-auto rounded-lg border border-accent/40 bg-accent-faint p-4">{revision.revised_prompt}</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-line p-4">
              <DiffView original={revision.original_prompt} proposed={finalText} />
            </div>
          )}
          {editing ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={checkEdits} loading={busy === "validate"} disabled={!edited.trim()}>
                Check requirements in my edit
              </Button>
              {editCheck ? <span className="text-sm text-ink-soft">{editCheck.preservation.summary}</span> : <span className="text-sm text-ink-faint">Check before saving so nothing you need was removed.</span>}
            </div>
          ) : null}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <PreservationPanel report={(editCheck?.preservation ?? revision.preservation) as PreservationView} key={`${revision.revision_id}:${editCheck ? "edit" : "orig"}`} />
            <div className="space-y-5">
              {revision.key_improvements.length ? (
                <div>
                  <h3 className="text-base">Key improvements</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {revision.key_improvements.map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {revision.assumptions_introduced.length ? (
                <div>
                  <h3 className="text-base">Assumptions in this version</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                    {revision.assumptions_introduced.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {revision.clarification_questions.length ? (
                <div>
                  <h3 className="text-base">Questions the assistant may ask</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                    {revision.clarification_questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={save} loading={busy === "save"} disabled={busy !== null || !finalText.trim()}>
                <Check className="h-4 w-4" aria-hidden="true" />
                {prompt ? "Accept and save as new version" : "Accept and save to My prompts"}
              </Button>
              <Button onClick={again} loading={busy === "again"} disabled={busy !== null || !lastRequest.current}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Generate another version
              </Button>
              {prompt ? (
                <Link href={`/app/library/${prompt.id}#versions`} className="btn btn-ghost">
                  Restore an earlier version
                </Link>
              ) : null}
            </div>
            <div className="flex items-center gap-1 text-sm text-ink-soft">
              <span className="mr-1">Was this helpful?</span>
              <Button size="sm" variant={rated[revision.revision_id] === 1 ? "primary" : "ghost"} onClick={() => rate(1)} aria-pressed={rated[revision.revision_id] === 1} aria-label="Helpful">
                <ThumbsUp className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button size="sm" variant={rated[revision.revision_id] === -1 ? "primary" : "ghost"} onClick={() => rate(-1)} aria-pressed={rated[revision.revision_id] === -1} aria-label="Not helpful">
                <ThumbsDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <p className="mt-3 text-[0.8125rem] text-ink-faint">The original is never overwritten. A more detailed or a shorter prompt is not guaranteed to produce a better answer; try it on your real task.</p>
        </section>
      ) : null}
    </div>
  );
}
