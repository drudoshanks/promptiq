import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { usageRecordsQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { listUsageRecords } from "@/lib/services/estimates";

/**
 * GET /api/v1/usage/records — the caller's actual API usage, one row per
 * provider attempt PromptIQ made on their behalf. Prompts the user runs in
 * ChatGPT or elsewhere are not, and cannot be, included.
 */
export const GET = withApi({ auth: "required" }, async ({ request, user }) => {
  const query = parseQuery(request, usageRecordsQuerySchema);
  return ok(await listUsageRecords(db, user.id, query.page, query.page_size));
});
