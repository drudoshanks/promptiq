"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { CATEGORY_LABELS, PREFERENCE_KEYS, PREFERENCE_LABELS, PREFERENCE_OPTIONS, TASK_CATEGORIES, type PreferenceKey, type TaskCategory } from "@/lib/categories";
import { api, errorMessage } from "@/lib/client/api";
import type { SerialisedPreference } from "@/lib/client/types";
import { formatDate } from "@/lib/utils";

const SOURCE_LABELS: Record<string, string> = {
  user_entered: "Set by you",
  user_confirmed: "Confirmed by you",
  feedback: "From feedback",
};

interface PreferencesManagerProps {
  initial: SerialisedPreference[];
  personalisationEnabled: boolean;
}

/** Preference memory screen (FR-010, §11): every row shows its provenance; changes apply immediately. */
export function PreferencesManager({ initial, personalisationEnabled }: PreferencesManagerProps) {
  const [items, setItems] = useState(initial);
  const [category, setCategory] = useState<TaskCategory>("general");
  const [key, setKey] = useState<PreferenceKey>("tone");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const options = key in PREFERENCE_OPTIONS ? PREFERENCE_OPTIONS[key as keyof typeof PREFERENCE_OPTIONS] : null;

  async function create() {
    if (!value.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const created = await api<SerialisedPreference>("/api/v1/preferences", {
        method: "POST",
        body: { category, preference_key: key, preference_value: { value: value.trim() } },
      });
      setItems((list) => [...list.filter((p) => p.id !== created.id), created].sort((a, b) => a.category.localeCompare(b.category) || a.preference_key.localeCompare(b.preference_key)));
      setValue("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const updated = await api<SerialisedPreference>(`/api/v1/preferences/${id}`, { method: "PATCH", body });
      setItems((list) => list.map((p) => (p.id === id ? updated : p)));
      setEditingId(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/v1/preferences/${id}`, { method: "DELETE" });
      setItems((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {!personalisationEnabled ? (
        <Alert tone="info">Saved preferences are switched off in Settings, so none of these are applied right now. They stay editable here.</Alert>
      ) : null}

      <section className="panel p-5">
        <h2 className="text-base">Add a preference</h2>
        <p className="mt-1 text-sm text-ink-soft">Applies to every rewrite in the chosen category. Anything you write in a prompt itself takes precedence.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
          <Field label="Applies to">
            {(p) => (
              <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as TaskCategory)}>
                {TASK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c === "general" ? "All tasks" : CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Preference">
            {(p) => (
              <Select
                id={p.id}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value as PreferenceKey);
                  setValue("");
                }}
              >
                {PREFERENCE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {PREFERENCE_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Value">
            {(p) =>
              options ? (
                <Select id={p.id} value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose</option>
                  {options.map((o) => (
                    <option key={o} value={o}>
                      {o.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input id={p.id} value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} placeholder={key === "constraints" ? "e.g. Never use emoji" : key === "audience" ? "e.g. senior engineers" : "e.g. British English"} />
              )
            }
          </Field>
          <Button variant="primary" loading={busy === "create"} disabled={!value.trim()} onClick={create}>
            Add
          </Button>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section>
        <h2 className="text-base">Saved preferences</h2>
        {items.length === 0 ? (
          <p className="panel-soft mt-3 p-6 text-center text-ink-soft">No preferences yet. PromptIQ never adds them on its own.</p>
        ) : (
          <div className="relative mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Applies to</th>
                  <th>Preference</th>
                  <th>Value</th>
                  <th>Where it came from</th>
                  <th>Applied</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className={p.enabled ? "" : "text-ink-faint"}>
                    <td>{p.category === "general" ? "All tasks" : (CATEGORY_LABELS[p.category as TaskCategory] ?? p.category)}</td>
                    <td>{PREFERENCE_LABELS[p.preference_key as PreferenceKey] ?? p.preference_key}</td>
                    <td>
                      {editingId === p.id ? (
                        <div className="flex gap-2">
                          <Input aria-label="New value" value={editValue} onChange={(e) => setEditValue(e.target.value)} maxLength={500} className="min-w-40" />
                          <Button size="sm" variant="primary" loading={busy === p.id} onClick={() => patch(p.id, { preference_value: { value: editValue } })}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <span className="break-words">{p.value.replace(/_/g, " ")}</span>
                      )}
                    </td>
                    <td>
                      <Badge title={`Added ${formatDate(p.created_at)}`}>{SOURCE_LABELS[p.source] ?? p.source}</Badge>
                    </td>
                    <td>
                      <Switch label={`Apply ${PREFERENCE_LABELS[p.preference_key as PreferenceKey] ?? p.preference_key}`} checked={p.enabled} disabled={busy === p.id} onChange={(next) => patch(p.id, { enabled: next })} />
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(p.id);
                            setEditValue(p.value);
                          }}
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => remove(p.id)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
