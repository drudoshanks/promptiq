import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { cancelPaymentRequest, getOwnedPaymentRequest, serialisePaymentRequest } from "@/lib/services/payments";

/** POST /api/v1/billing/payment-requests/{id}/cancel — cancel a request that has not been submitted. */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const request = await cancelPaymentRequest(db, user, id);
  const row = await getOwnedPaymentRequest(db, user.id, id);
  return ok(serialisePaymentRequest(request, row.plan));
});
