import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { libraryQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { searchTemplates } from "@/lib/services/prompt-library";

/** GET /api/v1/prompt-library — search and browse the Prompt library. */
export const GET = withApi({ auth: "required" }, async ({ request }) => {
  const query = parseQuery(request, libraryQuerySchema);
  return ok(await searchTemplates(db, { q: query.q, category: query.category, sort: query.sort, page: query.page, pageSize: query.page_size }));
});
