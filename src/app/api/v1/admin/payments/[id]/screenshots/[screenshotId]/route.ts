import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getScreenshot } from "@/lib/services/payments";

const paramsSchema = z.object({ id: z.uuid(), screenshotId: z.uuid() });

/** GET /api/v1/admin/payments/{id}/screenshots/{screenshotId} — private screenshot for administrators; never cached. */
export const GET = withApi<"admin", { id: string; screenshotId: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ user, params, log }) => {
  const { id, screenshotId } = paramsSchema.parse(params);
  const shot = await getScreenshot(db, { id: user.id, isAdmin: user.isAdmin }, id, screenshotId);
  log.info("payment screenshot viewed", { payment_request_id: id, admin_id: user.id });
  return new Response(new Uint8Array(shot.data), {
    status: 200,
    headers: {
      "Content-Type": shot.contentType,
      "Content-Length": String(shot.byteSize),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'",
      "Content-Disposition": "inline",
    },
  });
});
