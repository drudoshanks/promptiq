"use client";

import { Check, Copy, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/client/api";
import { fillPrompt, variableLabel } from "@/lib/prompt-library/categories";

interface TemplateFillerProps {
  slug: string;
  promptText: string;
  variables: string[];
}

const BLANK = /(\{\{\s*[a-zA-Z][\w ]{0,40}?\s*\}\})/g;

/** The prompt with blanks highlighted: orange while empty, green once filled. */
function Preview({ text, values }: { text: string; values: Record<string, string> }) {
  const parts = text.split(BLANK);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const name = part.replace(/^\{\{\s*|\s*\}\}$/g, "");
        const value = values[name]?.trim();
        return value ? (
          <mark key={i} className="blank-filled">
            {value}
          </mark>
        ) : (
          <mark key={i} className="blank">
            {part}
          </mark>
        );
      })}
    </>
  );
}

export function TemplateFiller({ slug, promptText, variables }: TemplateFillerProps) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ prompt_id: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filled = useMemo(() => fillPrompt(promptText, values), [promptText, values]);
  const remaining = variables.filter((v) => !values[v]?.trim()).length;

  const countUse = () => {
    void api(`/api/v1/prompt-library/${slug}/use`, { method: "POST" }).catch(() => undefined);
  };

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(filled);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      countUse();
    } catch {
      setError("Couldn't copy. Select the prompt text and copy it yourself.");
    }
  };

  const openInStudio = () => {
    try {
      sessionStorage.setItem(`piq:library:${slug}`, filled);
    } catch {
      // Storage unavailable: the Studio opens with the unfilled template.
    }
    countUse();
    router.push(`/app/studio?template=${encodeURIComponent(slug)}`);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) };
      setSaved(await api<{ prompt_id: string; title: string }>(`/api/v1/prompt-library/${slug}/save`, { method: "POST", body }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className="panel h-fit p-5" aria-labelledby="fill-heading">
        <h2 id="fill-heading" className="text-base font-semibold">
          {variables.length ? "Fill in the blanks" : "Ready to use"}
        </h2>
        {variables.length ? (
          <>
            <p className="mt-1 text-sm text-ink-soft">Optional. Anything you leave empty stays as a {"{{blank}}"} you can fill later.</p>
            <div className="mt-4 space-y-3">
              {variables.map((v) => (
                <div key={v}>
                  <label htmlFor={`var-${v}`} className="field-label">
                    {variableLabel(v)}
                  </label>
                  <textarea
                    id={`var-${v}`}
                    className="textarea"
                    rows={v.length > 0 && /text|draft|code|notes|content|error|data|details|description|context|article|transcript|email|message/i.test(v) ? 4 : 1}
                    value={values[v] ?? ""}
                    maxLength={5000}
                    onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-faint" aria-live="polite">
              {remaining === 0 ? "All blanks filled." : `${remaining} of ${variables.length} still empty.`}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-soft">This prompt has no blanks. Copy it as it is, or open it in the Studio to adapt it.</p>
        )}
      </section>

      <section className="min-w-0 space-y-4" aria-labelledby="prompt-heading">
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="prompt-heading" className="text-base font-semibold">
              Prompt
            </h2>
            <span className="text-xs text-ink-faint">{filled.length.toLocaleString()} characters</span>
          </div>
          <div className="prompt-text mt-3 max-h-[32rem] overflow-y-auto rounded-xl border border-line bg-panel-soft p-4" data-testid="library-preview">
            <Preview text={promptText} values={values} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={openInStudio}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Open in Studio
            </Button>
            <Button onClick={copy}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy prompt"}
            </Button>
            <Button onClick={save} loading={saving} disabled={Boolean(saved)}>
              <Star className="h-4 w-4" aria-hidden="true" />
              {saved ? "Saved" : "Save to My prompts"}
            </Button>
          </div>
          {saved ? (
            <p className="mt-3 text-sm" role="status">
              Saved as your own copy. <Link href={`/app/library/${saved.prompt_id}`}>Open it in My prompts</Link>
            </p>
          ) : null}
          {error ? (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          ) : null}
        </div>
        <p className="text-sm text-ink-soft">
          Tip: <strong className="text-ink">Open in Studio</strong> scores the prompt, suggests fixes for your exact situation and can break it into smaller steps.
        </p>
      </section>
    </div>
  );
}
