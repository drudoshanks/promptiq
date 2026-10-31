import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { upiQrSvg } from "@/lib/payments/qr";
import { getOwnedPaymentRequest, serialisePaymentRequest, serialiseSubmission } from "@/lib/services/payments";

/** GET /api/v1/billing/payment-requests/{id} — one of the caller's requests, with the UPI QR while payable. */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const row = await getOwnedPaymentRequest(db, user.id, id);
  const payload = serialisePaymentRequest(row.r, row.plan);
  return ok({ ...payload, qr_svg: payload.upi_uri ? await upiQrSvg(payload.upi_uri) : null, submissions: row.submissions.map((s) => ({ ...serialiseSubmission(s), screenshot_id: undefined })) });
});
