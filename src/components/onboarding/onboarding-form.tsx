"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Select, Switch } from "@/components/ui/field";
import { PREFERENCE_OPTIONS } from "@/lib/categories";
import { api, errorMessage } from "@/lib/client/api";

const TONE_LABELS: Record<string, string> = {
  professional_direct: "Professional and direct",
  friendly: "Friendly",
  formal: "Formal",
  neutral: "Neutral",
  playful: "Playful",
};
const DETAIL_LABELS: Record<string, string> = { concise: "Concise", balanced: "Balanced", detailed: "Detailed" };
const FORMAT_LABELS: Record<string, string> = {
  natural: "Natural prose",
  structured: "Structured sections",
  bullet_points: "Bullet points",
  step_by_step: "Numbered steps",
};

interface OnboardingFormProps {
  initial: { historyEnabled: boolean; personalisationEnabled: boolean };
}

export function OnboardingForm({ initial }: OnboardingFormProps) {
  const router = useRouter();
  const [tone, setTone] = useState("");
  const [detail, setDetail] = useState("");
  const [format, setFormat] = useState("");
  const [history, setHistory] = useState(initial.historyEnabled);
  const [personalisation, setPersonalisation] = useState(initial.personalisationEnabled);
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function finish(savePreferences: boolean) {
    setBusy(savePreferences ? "save" : "skip");
    setError(null);
    try {
      if (savePreferences) {
        const picks: Array<[string, string]> = [
          ["tone", tone],
          ["detail", detail],
          ["format", format],
        ];
        for (const [key, value] of picks) {
          if (!value) continue;
          await api("/api/v1/preferences", {
            method: "POST",
            body: { category: "general", preference_key: key, preference_value: { value } },
          });
        }
      }
      await api("/api/v1/me/preferences-settings", {
        method: "PATCH",
        body: { history_enabled: history, personalisation_enabled: personalisation, onboarded: true },
      });
      router.push("/app/studio");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1>Set your defaults</h1>
      <p className="mt-3 text-ink-soft">
        These become saved preferences that every rewrite applies unless the prompt says otherwise. All of them are optional and editable later.
      </p>

      <div className="panel mt-8 space-y-6 p-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Default tone">
            {(p) => (
              <Select id={p.id} value={tone} onChange={(e) => setTone(e.target.value)}>
                <option value="">No preference</option>
                {PREFERENCE_OPTIONS.tone.map((v) => (
                  <option key={v} value={v}>
                    {TONE_LABELS[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Level of detail">
            {(p) => (
              <Select id={p.id} value={detail} onChange={(e) => setDetail(e.target.value)}>
                <option value="">No preference</option>
                {PREFERENCE_OPTIONS.detail.map((v) => (
                  <option key={v} value={v}>
                    {DETAIL_LABELS[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Answer format">
            {(p) => (
              <Select id={p.id} value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">No preference</option>
                {PREFERENCE_OPTIONS.format.map((v) => (
                  <option key={v} value={v}>
                    {FORMAT_LABELS[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="space-y-5 border-t border-line pt-6">
          <Switch
            checked={history}
            onChange={setHistory}
            label="Auto-save prompts I optimise"
            description="Saves each optimisation (original and proposal) to your library so you can compare and restore versions. Off means nothing is stored unless you save it."
          />
          <Switch
            checked={personalisation}
            onChange={setPersonalisation}
            label="Apply my saved preferences"
            description="Preferences are created only when you set or confirm them. Turn this off to optimise without them; your preferences stay editable."
          />
        </div>

        <p className="text-sm text-ink-soft">
          Prompts you optimise are sent to OpenAI&apos;s API from our servers. Feedback you give is used to improve your own results, never to train models.
        </p>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" loading={busy === "skip"} disabled={busy === "save"} onClick={() => finish(false)}>
            Skip for now
          </Button>
          <Button variant="primary" loading={busy === "save"} disabled={busy === "skip"} onClick={() => finish(true)}>
            Save and open the studio
          </Button>
        </div>
      </div>
    </div>
  );
}
