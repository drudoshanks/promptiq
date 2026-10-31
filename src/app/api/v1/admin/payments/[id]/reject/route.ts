import { ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, rejectPaymentSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { dispatchNotificationsSoon } from "@/lib/services/payment-context";
import { getAdminPaymentDetail, rejectPayment, serialisePaymentRequest } from "@/lib/services/payments";

/** POST /api/v1/admin/payments/{id}/reject — reject with a reason shown to the customer (administrators only, audited). */
export const POST = withApi<"admin", { id: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const actor = { id: user.id, isAdmin: user.isAdmin };
  const body = await parseJson(request, rejectPaymentSchema);
  await rejectPayment(db, actor, id, body.reason);
  dispatchNotificationsSoon();
  const d = await getAdminPaymentDetail(db, actor, id);
  return ok(serialisePaymentRequest(d.request, d.plan));
});
