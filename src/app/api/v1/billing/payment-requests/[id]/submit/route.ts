import { AppError } from "@/lib/api/errors";
import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema, submitPaymentSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { MAX_SCREENSHOT_BYTES } from "@/lib/payments/screenshot";
import { parseInrToMinor } from "@/lib/payments/upi";
import { dispatchNotificationsSoon } from "@/lib/services/payment-context";
import { serialisePaymentRequest, serialiseSubmission, submitPayment } from "@/lib/services/payments";
import { getOwnedPaymentRequest } from "@/lib/services/payments";

/**
 * POST /api/v1/billing/payment-requests/{id}/submit — the user's claim that
 * they paid: transaction reference, time, amount, optional screenshot (multipart
 * field "screenshot") and notes. Recorded as unverified; grants nothing.
 */
export const POST = withApi<"required", { id: string }>({ auth: "required", rateLimit: "paymentSubmitPerHour" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_SCREENSHOT_BYTES + 64 * 1024) throw new AppError("PAYLOAD_TOO_LARGE", "Screenshots can be up to 2 MB.");

  let fields: Record<string, unknown>;
  let screenshot: Uint8Array | null = null;
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("VALIDATION_ERROR", "The form could not be read.");
    }
    fields = { transaction_reference: form.get("transaction_reference") ?? "", paid_at: form.get("paid_at") ?? "", amount: form.get("amount") ?? "", notes: form.get("notes") || null };
    const file = form.get("screenshot");
    if (file && typeof file !== "string" && file.size > 0) {
      if (file.size > MAX_SCREENSHOT_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Screenshots can be up to 2 MB.");
      screenshot = new Uint8Array(await file.arrayBuffer());
    }
  } else {
    try {
      fields = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
    }
  }
  const parsed = submitPaymentSchema.safeParse(fields);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Check the payment details and try again.", { details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  const amountMinor = parseInrToMinor(parsed.data.amount);
  if (amountMinor === null) throw new AppError("VALIDATION_ERROR", "Enter the amount you paid, for example 499.00.", { details: { field: "amount" } });

  const result = await submitPayment(db, user, id, { transactionReference: parsed.data.transaction_reference, paidAt: new Date(parsed.data.paid_at), amountMinor, notes: parsed.data.notes ?? null, screenshot });
  dispatchNotificationsSoon();
  const row = await getOwnedPaymentRequest(db, user.id, id);
  return ok({ ...serialisePaymentRequest(result.request, row.plan), submission: { ...serialiseSubmission(result.submission), screenshot_id: undefined }, message: "Payment details submitted. Your subscription will be activated after verification." });
});
