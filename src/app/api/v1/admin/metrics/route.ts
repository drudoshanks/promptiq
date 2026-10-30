import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getAdminMetrics } from "@/lib/services/admin";

/** GET /api/v1/admin/metrics — aggregate operator metrics, no prompt content (FR-020). */
export const GET = withApi({ auth: "admin" }, async ({ user, log }) => {
  log.info("admin metrics viewed", { operator_id: user.id }); // privileged access is audited (§4)
  return ok(await getAdminMetrics(db));
});
