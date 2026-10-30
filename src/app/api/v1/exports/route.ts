import { withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { buildAccountExport } from "@/lib/services/exports";

/**
 * POST /api/v1/exports — export everything the caller owns as one JSON document
 * (FR-016; format documented in docs/data-export-format.md).
 *
 * The SRS sketches this as an asynchronous 202 job; per-account data is small
 * enough in the MVP to return the document directly, so this responds 200 with
 * the file. Rate limited to a few exports per hour.
 */
export const POST = withApi({ auth: "required", rateLimit: "exportPerHour" }, async ({ user, requestId }) => {
  const document = await buildAccountExport(db, user);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(`${JSON.stringify(document, null, 2)}\n`, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="promptiq-export-${date}.json"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
});
