import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { suggestionsQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { listSuggestions } from "@/lib/services/analysis";

/** GET /api/v1/suggestions?status=pending,deferred — suggestions across the caller's library. */
export const GET = withApi({ auth: "required" }, async ({ request, user }) => {
  const query = parseQuery(request, suggestionsQuerySchema);
  return ok({ items: await listSuggestions(db, user.id, { status: query.status, page: query.page, pageSize: query.page_size }), page: query.page });
});
