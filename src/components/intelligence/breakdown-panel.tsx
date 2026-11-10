"use client";

import { ArrowDown, ArrowRight, BookmarkPlus, Check, CheckCircle2, Copy, Download, Layers, PencilLine, PlusCircle, SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";
import type { IntelligenceBreakdown } from "@/lib/services/breakdown";
import { cx, formatNumber } from "@/lib/utils";

type Step = IntelligenceBreakdown["steps"][number];

const LEVEL_TONE = { recommended: "accent", optional: "neutral", single: "neutral" } as const;
const LEVEL_LABEL = { recommended: "Splitting recommended", optional: "Splitting optional", single: "Works as one prompt" } as const;

/** Placeholders such as [Paste the output of step 1 here] are highlighted so they're hard to miss. */
function PromptText({ text }: { text: string }) {
  const parts = text.split(/(\[Paste[^\]]*\])/g);
  return (
    <p className="prompt-text">
      {parts.map((p, i) =>
        /^\[Paste[^\]]*\]$/.test(p) ? (
          <mark key={i} className="rounded bg-estimate-soft px-1 text-estimate">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </p>
  );
}

function toMarkdown(b: IntelligenceBreakdown, prompts: Record<number, string>): string {
  const lines = [`# ${b.title}`, "", "## How to use these prompts", "", ...b.usage_advice.map((a) => `- ${a}`), ""];
  for (const s of b.steps) {
    lines.push(`## Step ${s.number}: ${s.title}`, "", `**How to use:** ${s.how_to_use}`, "", `**Expect:** ${s.expected_output}`, "", "```text", prompts[s.number] ?? s.prompt, "```", "");
    if (s.checks.length) lines.push("**Check before continuing:**", "", ...s.checks.map((c) => `- [ ] ${c}`), "");
  }
  return lines.join("\n");
}

/** Steps grouped by when they can run: a group with several steps can run in any order. */
function runOrder(steps: Step[]): Step[][] {
  const level = new Map<number, number>();
  for (const s of steps) level.set(s.number, 1 + Math.max(0, ...s.depends_on.map((d) => level.get(d) ?? 0)));
  const groups = new Map<number, Step[]>();
  for (const s of steps) groups.set(level.get(s.number)!, [...(groups.get(level.get(s.number)!) ?? []), s]);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    async copy(key: string, text: string) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
      } catch {
        setCopied(null);
      }
    },
  };
}

export function BreakdownPanel({ breakdown, targetModel, onUseStep, headingRef }: { breakdown: IntelligenceBreakdown; targetModel: string; onUseStep?: (step: Step, prompt: string) => void; headingRef?: React.Ref<HTMLHeadingElement> }) {
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ url: string; count: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showCoverage, setShowCoverage] = useState(breakdown.coverage.added > 0);
  const { copied, copy } = useCopy();

  const prompts = useMemo(() => Object.fromEntries(breakdown.steps.map((s) => [s.number, edits[s.number] ?? s.prompt])), [breakdown.steps, edits]);
  const order = useMemo(() => runOrder(breakdown.steps), [breakdown.steps]);
  const reqById = useMemo(() => new Map(breakdown.coverage.items.map((c) => [c.id, c])), [breakdown.coverage.items]);
  const progress = Math.round((done.size / breakdown.steps.length) * 100);

  function download() {
    const blob = new Blob([toMarkdown(breakdown, prompts)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${breakdown.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "steps"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api<{ library_url: string; prompts: unknown[] }>("/api/v1/prompt-intelligence/breakdown/save", {
        method: "POST",
        body: { title: breakdown.title, category: breakdown.category, target_model: targetModel, breakdown_id: breakdown.breakdown_id, steps: breakdown.steps.map((s) => ({ title: s.title, prompt: prompts[s.number], how_to_use: s.how_to_use })) },
      });
      setSaved({ url: r.library_url, count: r.prompts.length });
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const stepLabel = (n: number) => breakdown.steps.find((s) => s.number === n)?.title ?? `Step ${n}`;

  return (
    <section aria-labelledby="breakdown-heading" className="panel scroll-mt-6 p-5" data-testid="breakdown">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-accent-deep">
            <Layers className="h-4 w-4" aria-hidden="true" />
            Step-by-step prompts
          </p>
          <h2 id="breakdown-heading" ref={headingRef} tabIndex={-1} className="mt-1 text-lg outline-none">
            {breakdown.title}
          </h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            {breakdown.steps.length} steps · {breakdown.category_label} · {breakdown.engine === "model" ? "planned by the AI model" : "planned by built-in rules"} · {formatNumber(breakdown.tokens.steps_total)} tokens in total vs {formatNumber(breakdown.tokens.original)} in your prompt
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => copy("all", toMarkdown(breakdown, prompts))}>
            {copied === "all" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied === "all" ? "Copied" : "Copy all"}
          </Button>
          <Button size="sm" onClick={download}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download .md
          </Button>
          {saved ? (
            <Link href={saved.url} className="btn btn-primary btn-sm no-underline">
              <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
              View {saved.count} saved steps
            </Link>
          ) : (
            <Button size="sm" variant="primary" onClick={save} loading={saving}>
              <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
              Save steps to My prompts
            </Button>
          )}
        </div>
      </div>

      {saveError ? (
        <Alert tone="error" className="mt-4">
          {saveError}
        </Alert>
      ) : null}
      {breakdown.fallback_reason ? (
        <Alert tone="warning" className="mt-4">
          {breakdown.fallback_reason}
        </Alert>
      ) : null}

      {/* Why split */}
      <div className={cx("mt-4 rounded-lg px-4 py-3", breakdown.assessment.level === "recommended" ? "bg-accent-faint" : "bg-panel-soft")}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={LEVEL_TONE[breakdown.assessment.level]}>{LEVEL_LABEL[breakdown.assessment.level]}</Badge>
          <p className="text-[0.9375rem] font-medium">{breakdown.assessment.headline}</p>
        </div>
        {breakdown.assessment.reasons.length ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
            {breakdown.assessment.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Run order */}
      <div className="mt-5">
        <h3 className="text-base">Run order</h3>
        <ol className="mt-2 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch" aria-label="Order to run the steps">
          {order.map((group, gi) => (
            <li key={gi} className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className={cx("flex flex-col gap-1.5", group.length > 1 && "rounded-lg border border-dashed border-line-strong p-1.5")}>
                {group.length > 1 ? <span className="px-1 text-[0.75rem] font-medium uppercase tracking-wide text-ink-faint">Any order</span> : null}
                {group.map((s) => (
                  <a key={s.number} href={`#step-${s.number}`} className={cx("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm no-underline", done.has(s.number) ? "border-accent bg-accent-soft text-accent-deep" : "border-line bg-panel text-ink hover:border-line-strong")}>
                    <span className={cx("grid h-5 w-5 flex-none place-items-center rounded-full text-[0.75rem] font-semibold", done.has(s.number) ? "bg-accent text-white" : "bg-sunken text-ink-soft")}>{done.has(s.number) ? <Check className="h-3 w-3" aria-hidden="true" /> : s.number}</span>
                    <span className="max-w-[16rem] truncate">{s.title}</span>
                  </a>
                ))}
              </div>
              {gi < order.length - 1 ? (
                <>
                  <ArrowRight className="hidden h-4 w-4 flex-none text-ink-faint md:block" aria-hidden="true" />
                  <ArrowDown className="ml-3 h-4 w-4 flex-none text-ink-faint md:hidden" aria-hidden="true" />
                </>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Steps done" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[0.8125rem] text-ink-soft">
            {done.size} of {breakdown.steps.length} done
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        {/* Steps */}
        <ol className="space-y-4" aria-label="Steps">
          {breakdown.steps.map((s) => {
            const isDone = done.has(s.number);
            const prompt = prompts[s.number] ?? s.prompt;
            const carried = s.requirement_ids.map((id) => reqById.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
            return (
              <li key={s.number} id={`step-${s.number}`} className={cx("scroll-mt-6 rounded-xl border p-4", isDone ? "border-accent bg-accent-faint" : "border-line")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-3">
                    <span className={cx("grid h-8 w-8 flex-none place-items-center rounded-full font-semibold", isDone ? "bg-accent text-white" : "bg-accent-soft text-accent-deep")}>{s.number}</span>
                    <div className="min-w-0">
                      <h3 className="text-base">{s.title}</h3>
                      {s.goal ? <p className="text-sm text-ink-soft">{s.goal}</p> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {s.is_review ? <Badge tone="accent">Final check</Badge> : null}
                    {s.depends_on.length ? <Badge title={s.depends_on.map(stepLabel).join(", ")}>After step {s.depends_on.join(" + ")}</Badge> : !s.is_review && breakdown.steps.some((t) => t.depends_on.includes(s.number)) ? <Badge>Start here</Badge> : !s.is_review && breakdown.steps.length > 1 ? <Badge>Independent</Badge> : null}
                    <Badge tone="estimate">{formatNumber(s.tokens)} tokens</Badge>
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-line bg-panel-soft">
                  <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
                    <span className="text-[0.8125rem] font-medium text-ink-soft">Prompt {edits[s.number] !== undefined ? "· edited" : ""}</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(editing === s.number ? null : s.number)} aria-pressed={editing === s.number}>
                        <PencilLine className="h-4 w-4" aria-hidden="true" />
                        {editing === s.number ? "Done" : "Edit"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => copy(`s${s.number}`, prompt)} aria-label={`Copy step ${s.number} prompt`}>
                        {copied === `s${s.number}` ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                        {copied === `s${s.number}` ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-80 overflow-auto px-3 py-2.5">
                    {editing === s.number ? (
                      <Textarea value={prompt} onChange={(e) => setEdits((x) => ({ ...x, [s.number]: e.target.value }))} rows={12} aria-label={`Edit step ${s.number} prompt`} />
                    ) : (
                      <PromptText text={prompt} />
                    )}
                  </div>
                </div>

                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">How to use</dt>
                    <dd className="mt-0.5 text-ink-soft">{s.how_to_use}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">A good answer has</dt>
                    <dd className="mt-0.5 text-ink-soft">{s.expected_output}</dd>
                  </div>
                </dl>

                {s.checks.length ? (
                  <div className="mt-3">
                    <p className="text-sm font-medium">Check before moving on</p>
                    <ul className="mt-1 space-y-1">
                      {s.checks.map((c) => (
                        <li key={c} className="flex gap-2 text-sm text-ink-soft">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-ink-faint" aria-hidden="true" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {carried.length && !s.is_review ? (
                  <p className="mt-3 text-[0.8125rem] text-ink-faint">
                    Carries {carried.length} of your requirement{carried.length === 1 ? "" : "s"}
                    {carried.some((c) => c.status === "added" && c.steps.includes(s.number)) ? " (some added under “Also make sure”)" : ""}.
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={isDone} onChange={(e) => setDone((d) => (e.target.checked ? new Set([...d, s.number]) : new Set([...d].filter((n) => n !== s.number))))} />
                    I&apos;ve run this step
                  </label>
                  {onUseStep ? (
                    <Button size="sm" variant="ghost" onClick={() => onUseStep(s, prompt)}>
                      Improve this step in the editor
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Advice and coverage */}
        <aside className="space-y-4 xl:sticky xl:top-6 xl:h-fit">
          <div className="rounded-xl border border-line p-4">
            <h3 className="text-base">How to use these prompts</h3>
            <ol className="mt-2 space-y-2">
              {breakdown.usage_advice.map((a, i) => (
                <li key={a} className="flex gap-2 text-sm">
                  <span className="grid h-5 w-5 flex-none place-items-center rounded-full bg-sunken text-[0.75rem] font-semibold text-ink-soft">{i + 1}</span>
                  <span className="text-ink-soft">{a}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 rounded-md bg-panel-soft px-3 py-2 text-[0.8125rem] text-ink-soft">
              {breakdown.run_mode === "same_chat" ? "Tip: keep one chat open for the whole sequence." : "Tip: a new chat per step keeps each answer focused."}
            </p>
          </div>

          <div className="rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base">Requirement coverage</h3>
              <Badge tone={breakdown.coverage.added ? "warn" : "accent"}>
                {breakdown.coverage.covered + breakdown.coverage.added} of {breakdown.coverage.total} carried
              </Badge>
            </div>
            <p className="mt-1 text-sm text-ink-soft">{breakdown.coverage.summary}</p>
            {breakdown.coverage.items.length ? (
              <>
                <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={() => setShowCoverage((v) => !v)} aria-expanded={showCoverage}>
                  {showCoverage ? "Hide requirements" : "Show which step carries each requirement"}
                </Button>
                {showCoverage ? (
                  <ul className="mt-2 space-y-2">
                    {breakdown.coverage.items.map((c) => (
                      <li key={c.id} className="flex gap-2 text-sm">
                        {c.status === "added" ? <PlusCircle className="mt-0.5 h-4 w-4 flex-none text-warn" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-accent" aria-hidden="true" />}
                        <span className="min-w-0">
                          <span className="text-ink">{c.text}</span>
                          <span className="block text-[0.8125rem] text-ink-faint">
                            {c.kind_label} · step {c.steps.join(", ")}
                            {c.status === "added" ? " · added" : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}

export function BreakdownHint({ level, headline, reasons, onBreakdown, busy, children }: { level: "single" | "optional" | "recommended"; headline: string; reasons: string[]; onBreakdown: () => void; busy: boolean; children?: ReactNode }) {
  if (level === "single") return null;
  return (
    <div className={cx("mt-4 flex flex-wrap items-start justify-between gap-3 rounded-lg px-3 py-3", level === "recommended" ? "bg-accent-faint" : "bg-panel-soft")} data-testid="breakdown-hint">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[0.9375rem] font-medium">
          <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
          {headline}
        </p>
        {reasons[0] ? <p className="mt-0.5 text-sm text-ink-soft">{reasons[0]}</p> : null}
        {children}
      </div>
      <Button size="sm" variant={level === "recommended" ? "primary" : "secondary"} onClick={onBreakdown} loading={busy}>
        Break it down
      </Button>
    </div>
  );
}
