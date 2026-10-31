import { AppError } from "@/lib/api/errors";
import { ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, verifyPaymentSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { parseInrToMinor } from "@/lib/payments/upi";
import { dispatchNotificationsSoon } from "@/lib/services/payment-context";
import { getAdminPaymentDetail, serialisePaymentRequest, verifyPayment } from "@/lib/services/payments";

/**
 * POST /api/v1/admin/payments/{id}/verify — after checking the business's bank
 * statement or UPI merchant app, verify the payment and activate the
 * subscription in one transaction. Idempotent: repeating it changes nothing.
 */
export const POST = withApi<"admin", { id: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ request, user, params, log }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, verifyPaymentSchema);
  const verifiedAmountMinor = parseInrToMinor(body.verified_amount);
  if (verifiedAmountMinor === null) throw new AppError("VALIDATION_ERROR", "Enter the amount shown in your bank or merchant records, for example 499.00.");
  const actor = { id: user.id, isAdmin: user.isAdmin };
  const result = await verifyPayment(db, actor, id, {
    confirmedIndependentCheck: body.confirmed_independent_check,
    verificationNotes: body.verification_notes,
    verifiedAmountMinor,
    discrepancyResolution: body.discrepancy_resolution ?? null,
    recoveryReason: body.recovery_reason ?? null,
    transactionReference: body.transaction_reference ?? null,
  });
  log.info("admin payment action", { action: "verify", payment_request_id: id, admin_id: user.id, already_verified: result.alreadyVerified });
  dispatchNotificationsSoon();
  const d = await getAdminPaymentDetail(db, actor, id);
  return ok({ ...serialisePaymentRequest(d.request, d.plan), already_verified: result.alreadyVerified, subscription: result.subscription });
});
