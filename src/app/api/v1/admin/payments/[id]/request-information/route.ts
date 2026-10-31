import { ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, requestInformationSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { dispatchNotificationsSoon } from "@/lib/services/payment-context";
import { getAdminPaymentDetail, requestInformation, serialisePaymentRequest } from "@/lib/services/payments";

/** POST /api/v1/admin/payments/{id}/request-information — ask the customer for more information (administrators only, audited). */
export const POST = withApi<"admin", { id: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const actor = { id: user.id, isAdmin: user.isAdmin };
  const body = await parseJson(request, requestInformationSchema);
  await requestInformation(db, actor, id, body.message);
  dispatchNotificationsSoon();
  const d = await getAdminPaymentDetail(db, actor, id);
  return ok(serialisePaymentRequest(d.request, d.plan));
});
