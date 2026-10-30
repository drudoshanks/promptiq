import { AppError } from "@/lib/api/errors";
import { accepted, parseJson, withApi } from "@/lib/api/handler";
import { deletionRequestSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { requestAccountDeletion } from "@/lib/services/deletion";

/**
 * POST /api/v1/account/deletion — start the tracked deletion workflow (FR-017).
 * Requires a fresh sign-in (SRS §12.2 "recent re-authentication") and a typed
 * confirmation of the account email.
 */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, log }) => {
  const body = await parseJson(request, deletionRequestSchema);
  if (!user.session.isFresh) {
    throw new AppError("REAUTH_REQUIRED", "For your safety, please sign out and sign in again before deleting your account.", {
      details: { session_created_at: user.session.createdAt.toISOString() },
    });
  }
  if (!user.email || body.confirm_email.trim().toLowerCase() !== user.email) {
    throw new AppError("VALIDATION_ERROR", "The email you typed does not match this account.");
  }
  const job = await requestAccountDeletion(db, user.id);
  log.info("account deletion completed", { job_id: job.id, status: job.status });
  return accepted({
    job_id: job.id,
    status: job.status,
    requested_at: job.requestedAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
    note: "Your prompts, versions, preferences and feedback have been deleted and your sign-in removed. Copies in encrypted backups expire within 30 days.",
  });
});
