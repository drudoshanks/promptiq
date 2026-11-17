import { AppError } from "@/lib/api/errors";
import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { isFreeMode } from "@/lib/config/plans";
import { createPaymentRequestSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { dispatchNotificationsSoon, upiConfig } from "@/lib/services/payment-context";
import { createPaymentRequest, listPaymentRequests, serialisePaymentRequest } from "@/lib/services/payments";

/** GET /api/v1/billing/payment-requests — the caller's payment requests, newest first. */
export const GET = withApi({ auth: "required" }, async ({ user }) => {
  const rows = await listPaymentRequests(db, user.id);
  return ok({ items: rows.map((r) => serialisePaymentRequest(r.r, r.plan)) });
});

/**
 * POST /api/v1/billing/payment-requests — start paying for a plan. Only the
 * plan code is accepted; price, payee and reference come from the server.
 * Re-selecting the plan of an open request returns it (200) instead of a duplicate.
 */
export const POST = withApi({ auth: "required", rateLimit: "paymentCreatePerHour" }, async ({ request, user }) => {
  if (isFreeMode()) throw new AppError("FORBIDDEN", "PromptIQ is free right now, so there's nothing to pay for.");
  const body = await parseJson(request, createPaymentRequestSchema);
  const result = await createPaymentRequest(db, user, { planCode: body.plan_code }, upiConfig());
  if (result.created) dispatchNotificationsSoon();
  const payload = serialisePaymentRequest(result.request, result.plan);
  return result.created ? created(payload) : ok(payload);
});
