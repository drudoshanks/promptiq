"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import {
  CATEGORY_LABELS,
  FEEDBACK_REASON_CODES,
  FEEDBACK_REASON_LABELS,
  PREFERENCE_KEYS,
  PREFERENCE_LABELS,
  TASK_CATEGORIES,
  type FeedbackReasonCode,
  type PreferenceKey,
  type TaskCategory,
} from "@/lib/categories";
import { api, errorMessage } from "@/lib/client/api";
import type { FeedbackResponse } from "@/lib/client/types";

interface FeedbackPanelProps {
  optimisationId: string;
  category: TaskCategory;
}

/**
 * Explicit feedback (FR-011). Feedback is never turned into a preference by
 * itself (FR-012); the user can choose to save one alongside it, and the
 * server records that choice with source=user_confirmed.
 */
export function FeedbackPanel({ optimisationId, category }: FeedbackPanelProps) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [reason, setReason] = useState<FeedbackReasonCode | "">("");
  const [comment, setComment] = useState("");
  const [savePref, setSavePref] = useState(false);
  const [prefKey, setPrefKey] = useState<PreferenceKey>("tone");
  const [prefValue, setPrefValue] = useState("");
  const [prefCategory, setPrefCategory] = useState<TaskCategory>(category);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<FeedbackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<FeedbackResponse>(`/api/v1/optimisations/${optimisationId}/feedback`, {
        method: "POST",
        body: {
          rating,
          reason_code: reason || null,
          comment: comment.trim() || null,
          replace: Boolean(submitted),
          save_preference: savePref && prefValue.trim() ? { category: prefCategory, preference_key: prefKey, value: prefValue.trim() } : null,
        },
      });
      setSubmitted(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/optimisations/${optimisationId}/feedback`, { method: "DELETE" });
      setSubmitted(null);
      setRating(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="feedback-heading" className="panel-soft p-5">
      <h3 id="feedback-heading" className="text-base">
        Was this rewrite helpful?
      </h3>
      <p className="mt-1 text-sm text-ink-soft">Your answer improves your own future rewrites. It is stored with this optimisation and you can withdraw it.</p>

      {submitted ? (
        <div className="mt-4 space-y-3">
          <Alert tone="success">
            Thanks, feedback recorded{submitted.saved_preference ? ` and your ${PREFERENCE_LABELS[submitted.saved_preference.preference_key as PreferenceKey]?.toLowerCase() ?? "preference"} was saved` : ""}.
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setSubmitted(null)}>
              Change answer
            </Button>
            <Button size="sm" variant="ghost" onClick={withdraw} loading={busy}>
              Withdraw feedback
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex gap-2" role="group" aria-label="Rating">
            <Button size="sm" variant={rating === 1 ? "primary" : "secondary"} aria-pressed={rating === 1} onClick={() => setRating(1)}>
              <ThumbsUp className="h-4 w-4" aria-hidden="true" /> Helpful
            </Button>
            <Button size="sm" variant={rating === -1 ? "primary" : "secondary"} aria-pressed={rating === -1} onClick={() => setRating(-1)}>
              <ThumbsDown className="h-4 w-4" aria-hidden="true" /> Not helpful
            </Button>
          </div>

          {rating !== null ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Reason (optional)">
                  {(p) => (
                    <Select id={p.id} value={reason} onChange={(e) => setReason(e.target.value as FeedbackReasonCode | "")}>
                      <option value="">Choose a reason</option>
                      {FEEDBACK_REASON_CODES.map((code) => (
                        <option key={code} value={code}>
                          {FEEDBACK_REASON_LABELS[code]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Comment (optional)">
                  {(p) => <Textarea id={p.id} rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} className="font-sans" />}
                </Field>
              </div>

              <div className="border-t border-line pt-4">
                <label className="flex items-start gap-3 text-[0.9375rem]">
                  <input type="checkbox" className="mt-1" checked={savePref} onChange={(e) => setSavePref(e.target.checked)} />
                  <span>
                    Also save a preference for future rewrites
                    <span className="block text-sm text-ink-soft">Only what you type here is stored. You can edit or delete it under Preferences.</span>
                  </span>
                </label>
                {savePref ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Applies to">
                      {(p) => (
                        <Select id={p.id} value={prefCategory} onChange={(e) => setPrefCategory(e.target.value as TaskCategory)}>
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
                        <Select id={p.id} value={prefKey} onChange={(e) => setPrefKey(e.target.value as PreferenceKey)}>
                          {PREFERENCE_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {PREFERENCE_LABELS[k]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Value">
                      {(p) => <Input id={p.id} value={prefValue} onChange={(e) => setPrefValue(e.target.value)} maxLength={500} placeholder="e.g. concise" />}
                    </Field>
                  </div>
                ) : null}
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}
              <Button variant="primary" size="sm" loading={busy} onClick={submit}>
                Send feedback
              </Button>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
