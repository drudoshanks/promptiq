import { and, eq } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import type { FeedbackReasonCode } from "@/lib/categories";
import { feedback, type Feedback } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

import { getRun } from "./usage";

export interface SubmitFeedbackInput {
  rating: 1 | -1;
  reasonCode?: FeedbackReasonCode | null;
  comment?: string | null;
  /** The preference the user chose to save alongside this feedback (for audit). */
  preferenceSuggestion?: Record<string, unknown> | null;
  /** Deliberately update an existing record instead of returning 409. */
  replace?: boolean;
}

/**
 * Explicit feedback (FR-011): one record per run per user. A second submission is
 * a conflict unless the caller sets `replace`, which updates in place so there are
 * never duplicates (§13.2).
 */
export async function submitFeedback(db: DbOrTx, userId: string, runId: string, input: SubmitFeedbackInput): Promise<{ feedback: Feedback; created: boolean }> {
  const run = await getRun(db, userId, runId);
  if (!run) throw notFound("Optimisation");

  const existing = await db.query.feedback.findFirst({
    where: and(eq(feedback.userId, userId), eq(feedback.runId, runId)),
  });

  const values = {
    rating: input.rating,
    reasonCode: input.reasonCode ?? null,
    comment: input.comment?.trim().slice(0, 1000) || null,
    preferenceSuggestion: input.preferenceSuggestion ?? null,
  };

  if (existing) {
    if (!input.replace) {
      throw new AppError("CONFLICT", "Feedback already recorded for this optimisation. Send replace=true to update it.", {
        details: { feedback_id: existing.id },
      });
    }
    const [updated] = await db
      .update(feedback)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(feedback.id, existing.id), eq(feedback.userId, userId)))
      .returning();
    if (!updated) throw notFound("Feedback");
    return { feedback: updated, created: false };
  }

  const [created] = await db
    .insert(feedback)
    .values({ userId, runId, ...values })
    .returning();
  if (!created) throw new Error("Failed to record feedback");
  return { feedback: created, created: true };
}

/** FR-021: withdraw feedback. */
export async function deleteFeedback(db: DbOrTx, userId: string, runId: string): Promise<void> {
  const deleted = await db
    .delete(feedback)
    .where(and(eq(feedback.userId, userId), eq(feedback.runId, runId)))
    .returning({ id: feedback.id });
  if (deleted.length === 0) throw notFound("Feedback");
}

export async function getFeedbackForRun(db: DbOrTx, userId: string, runId: string): Promise<Feedback | null> {
  const row = await db.query.feedback.findFirst({
    where: and(eq(feedback.userId, userId), eq(feedback.runId, runId)),
  });
  return row ?? null;
}

export function serialiseFeedback(f: Feedback) {
  return {
    id: f.id,
    run_id: f.runId,
    rating: f.rating,
    reason_code: f.reasonCode,
    comment: f.comment,
    preference_suggestion: f.preferenceSuggestion,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  };
}
