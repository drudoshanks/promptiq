import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { createCheckoutSession } from "@/lib/services/billing";

/** POST /api/v1/billing/checkout — create a hosted checkout session (FR-015). */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ user }) => {
  const session = await createCheckoutSession(db, user);
  return ok(session);
});
