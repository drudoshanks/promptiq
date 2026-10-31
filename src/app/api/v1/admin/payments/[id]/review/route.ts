import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { dispatchNotificationsSoon } from "@/lib/services/payment-context";
import { getAdminPaymentDetail, markUnderReview, serialisePaymentRequest } from "@/lib/services/payments";

/** POST /api/v1/admin/payments/{id}/review — mark the payment under review (administrators only, audited). */
export const POST = withApi<"admin", { id: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const actor = { id: user.id, isAdmin: user.isAdmin };

  await markUnderReview(db, actor, id);
  dispatchNotificationsSoon();
  const d = await getAdminPaymentDetail(db, actor, id);
  return ok(serialisePaymentRequest(d.request, d.plan));
});
