import { eq } from "drizzle-orm";

import { AppError } from "@/lib/api/errors";
import {
  promptFeedbackEvents,
  appUsers,
  authUser,
  deletionJobs,
  feedback,
  prompts,
  tokenEstimates,
  userPreferences,
  type DeletionJob,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Account deletion workflow (FR-017, §12.2).
 *
 * 1. Caller has verified a fresh re-authentication.
 * 2. Create a deletion job, mark the account pending deletion.
 * 3. Delete prompts, versions, preferences, feedback and token estimates.
 * 4. Anonymise the profile and delete credentials/sessions (auth tables cascade).
 * 5. Keep optimisation_runs, api_usage_records and usage_events (metadata only,
 *    no prompt text) as
 *    the billing/abuse audit record required by §9.3; they reference the
 *    anonymised profile row.
 * 6. Backups expire on the documented schedule (docs/privacy-data-handling.md).
 *
 * The job is executed synchronously in the MVP because the data volume per
 * account is small; the deletion_jobs row is the tracking record either way.
 */
export async function requestAccountDeletion(db: Db, userId: string): Promise<DeletionJob> {
  const existing = await db.query.deletionJobs.findFirst({ where: eq(deletionJobs.userId, userId) });
  if (existing && existing.status !== "failed") {
    throw new AppError("CONFLICT", "Account deletion is already in progress.", { details: { job_id: existing.id } });
  }

  const [job] = await db.insert(deletionJobs).values({ userId, status: "running" }).returning();
  if (!job) throw new Error("Failed to create deletion job");

  try {
    await db.transaction(async (tx) => {
      const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
      if (!user) throw new Error("User not found");

      await tx.delete(feedback).where(eq(feedback.userId, userId));
      await tx.delete(promptFeedbackEvents).where(eq(promptFeedbackEvents.userId, userId));
      await tx.delete(tokenEstimates).where(eq(tokenEstimates.userId, userId));
      await tx.delete(prompts).where(eq(prompts.userId, userId)); // versions cascade
      await tx.delete(userPreferences).where(eq(userPreferences.userId, userId));

      await tx
        .update(appUsers)
        .set({
          email: null,
          displayName: null,
          historyEnabled: false,
          personalisationEnabled: false,
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(appUsers.id, userId));

      // Credentials, OAuth accounts and sessions: cascade from the auth user row.
      await tx.delete(authUser).where(eq(authUser.id, user.authSubject));
    });

    const [completed] = await db
      .update(deletionJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(deletionJobs.id, job.id))
      .returning();
    return completed ?? job;
  } catch (error) {
    await db
      .update(deletionJobs)
      .set({ status: "failed", errorCode: (error as Error).message.slice(0, 120) })
      .where(eq(deletionJobs.id, job.id));
    throw error;
  }
}
