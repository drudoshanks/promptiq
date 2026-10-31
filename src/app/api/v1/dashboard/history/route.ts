import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { historyQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { listOptimisationHistory } from "@/lib/services/dashboard";

/** GET /api/v1/dashboard/history — optimisation runs across the library, newest first. */
export const GET = withApi({ auth: "required" }, async ({ request, user }) => {
  const query = parseQuery(request, historyQuerySchema);
  return ok(await listOptimisationHistory(db, user.id, query.page, query.page_size));
});
