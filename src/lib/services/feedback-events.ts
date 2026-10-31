import { promptFeedbackEvents, type FeedbackEventType } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

/**
 * Explicit interaction log for personalisation (§10). Records categories and
 * modes only — never prompt text — and only for actions the user took.
 */
export interface FeedbackEventInput {
  userId: string;
  eventType: FeedbackEventType;
  promptId?: string | null;
  promptVersionId?: string | null;
  suggestionId?: string | null;
  runId?: string | null;
  suggestionCategory?: string | null;
  taskCategory?: string | null;
  optimisationMode?: string | null;
}

export async function recordFeedbackEvent(db: DbOrTx, input: FeedbackEventInput): Promise<void> {
  await recordFeedbackEvents(db, [input]);
}

export async function recordFeedbackEvents(db: DbOrTx, inputs: FeedbackEventInput[]): Promise<void> {
  if (!inputs.length) return;
  await db.insert(promptFeedbackEvents).values(
    inputs.map((i) => ({
      userId: i.userId,
      eventType: i.eventType,
      promptId: i.promptId ?? null,
      promptVersionId: i.promptVersionId ?? null,
      suggestionId: i.suggestionId ?? null,
      runId: i.runId ?? null,
      suggestionCategory: i.suggestionCategory ?? null,
      taskCategory: i.taskCategory ?? null,
      optimisationMode: i.optimisationMode ?? null,
    })),
  );
}

export const STATUS_EVENT: Partial<Record<string, FeedbackEventType>> = {
  accepted: "suggestion_accepted",
  dismissed: "suggestion_dismissed",
  deferred: "suggestion_deferred",
};
