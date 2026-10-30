import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { createPortalSession } from "@/lib/services/billing";

/** POST /api/v1/billing/portal — hosted portal for cancellation/renewal (FR-015). */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ user }) => {
  const session = await createPortalSession(db, user);
  return ok(session);
});
