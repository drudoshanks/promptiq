"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";

export interface PromptPreferencesValue {
  preferred_model: string | null;
  preferred_style: string | null;
  preferred_response_length: string | null;
  token_efficiency_priority: string;
  default_optimisation_mode: string;
  domains: string[];
  learn_from_feedback: boolean;
  background_analysis: boolean;
}

interface Props {
  initial: PromptPreferencesValue;
  models: Array<{ id: string; label: string }>;
  feedbackHistory: Array<{ category: string; label: string; accepted: number; dismissed: number }>;
}

/** Prompt preferences used to tailor suggestions and optimisation (Prompt Library §8). */
export function PromptPreferencesForm({ initial, models, feedbackHistory }: Props) {
  const [v, setV] = useState(initial);
  const [domains, setDomains] = useState(initial.domains.join(", "));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [history, setHistory] = useState(feedbackHistory);

  const set = <K extends keyof PromptPreferencesValue>(key: K, value: PromptPreferencesValue[K]) => setV((x) => ({ ...x, [key]: value }));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/v1/preferences/prompts", {
        method: "PATCH",
        body: { ...v, domains: domains.split(",").map((d) => d.trim()).filter(Boolean) },
      });
      setMessage({ tone: "success", text: "Prompt preferences saved. They apply to your next analysis or optimisation." });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function resetFeedback() {
    setBusy(true);
    try {
      await api("/api/v1/preferences/prompts/reset-feedback", { method: "POST" });
      setHistory((h) => h.map((x) => ({ ...x, dismissed: 0 })));
      setMessage({ tone: "success", text: "Dismissed suggestions no longer influence future analyses." });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Preferred target model">
          {(p) => (
            <Select id={p.id} value={v.preferred_model ?? ""} onChange={(e) => set("preferred_model", e.target.value || null)}>
              <option value="">No preference</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Default optimisation mode">
          {(p) => (
            <Select id={p.id} value={v.default_optimisation_mode} onChange={(e) => set("default_optimisation_mode", e.target.value)}>
              <option value="balanced">Balanced</option>
              <option value="token_saver">Token saver</option>
              <option value="quality_first">Quality first</option>
            </Select>
          )}
        </Field>
        <Field label="Token efficiency priority" help="How strongly suggestions should favour fewer tokens.">
          {(p) => (
            <Select id={p.id} value={v.token_efficiency_priority} onChange={(e) => set("token_efficiency_priority", e.target.value)} aria-describedby={p.describedBy}>
              <option value="low">Low: clarity matters more</option>
              <option value="balanced">Balanced</option>
              <option value="high">High: keep prompts lean</option>
            </Select>
          )}
        </Field>
        <Field label="Preferred prompt style">
          {(p) => (
            <Select id={p.id} value={v.preferred_style ?? ""} onChange={(e) => set("preferred_style", e.target.value || null)}>
              <option value="">No preference</option>
              <option value="natural">Natural prose</option>
              <option value="structured">Structured sections</option>
              <option value="bullet_points">Bullet points</option>
              <option value="step_by_step">Numbered steps</option>
            </Select>
          )}
        </Field>
        <Field label="Preferred answer length">
          {(p) => (
            <Select id={p.id} value={v.preferred_response_length ?? ""} onChange={(e) => set("preferred_response_length", e.target.value || null)}>
              <option value="">No preference</option>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </Select>
          )}
        </Field>
        <Field label="Your use cases" help="Comma separated, in your own words, e.g. marketing emails, SQL queries.">
          {(p) => <Input id={p.id} value={domains} onChange={(e) => setDomains(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
      </div>

      <div className="space-y-5 border-t border-line pt-5">
        <Switch
          checked={v.learn_from_feedback}
          onChange={(x) => set("learn_from_feedback", x)}
          label="Learn from my suggestion decisions"
          description="Suggestion types you usually accept are favoured; types you keep dismissing are raised only when serious. Only your own decisions are used, never your prompt content."
        />
      </div>

      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Button variant="primary" loading={busy} onClick={save}>
        Save prompt preferences
      </Button>

      <div className="border-t border-line pt-5">
        <h3 className="text-base">What PromptIQ has learned from your decisions</h3>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">Nothing yet. Accept or dismiss suggestions and they will show here.</p>
        ) : (
          <>
            <table className="table mt-2">
              <thead>
                <tr>
                  <th scope="col">Suggestion type</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Dismissed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.category}>
                    <td>{h.label}</td>
                    <td>{h.accepted}</td>
                    <td>{h.dismissed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button className="mt-3" size="sm" variant="ghost" disabled={busy} onClick={resetFeedback}>
              Forget dismissed suggestions
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
